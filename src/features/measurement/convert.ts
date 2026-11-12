import type { MeasureUnit } from '../../domain/types';
import { dimensionOf, UNITS, unitLabel } from './units';

export const DEFAULT_CUP_ML = 240;
export const CUP_SIZES_ML = [200, 240, 250];
const TBSP_ML = 15;
const TSP_ML = 5;

export type ConversionInput = {
  quantity: number;
  from: MeasureUnit;
  to: MeasureUnit;
  /** g por mL do ingrediente; necessário para converter entre massa e volume. */
  densityGPerMl?: number;
  /** quanto pesa 1 unidade do ingrediente. */
  gramsPerUnit?: number;
  /** quantos mL tem 1 unidade do ingrediente. */
  mlPerUnit?: number;
  /** volume da xícara em mL (padrão 240). */
  cupSizeMl?: number;
};
export type ConversionError = 'INVALID_QUANTITY' | 'MISSING_DENSITY' | 'MISSING_UNIT_EQUIVALENCE' | 'INVALID_CONFIGURATION';
/**
 * Natureza do resultado: 'exact' (mesma grandeza, sem convenção: g↔kg, mL↔L, unidade↔unidade), 'convention' (usa xícara/colher,
 * que são convenções culinárias, não medidas físicas) ou 'reference' (massa↔volume ou unidade↔peso: depende da referência do ingrediente).
 */
export type ConversionBasis = 'exact' | 'convention' | 'reference';
export type ConversionResult = { success: true; value: number; approximate: boolean; basis: ConversionBasis } | { success: false; error: ConversionError };

const GRAMS: Record<string, number | undefined> = { g: 1, kg: 1000 };
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const invalidIfSet = (v: unknown) => v !== undefined && !isPositive(v);

/** Função pura. Não arredonda: o arredondamento é responsabilidade da apresentação. */
export function convert(input: ConversionInput): ConversionResult {
  const { quantity, from, to, densityGPerMl, gramsPerUnit, mlPerUnit } = input;
  const cup = input.cupSizeMl ?? DEFAULT_CUP_ML;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return { success: false, error: 'INVALID_QUANTITY' };
  if (!isPositive(cup) || invalidIfSet(densityGPerMl) || invalidIfSet(gramsPerUnit) || invalidIfSet(mlPerUnit) || !(from in UNITS) || !(to in UNITS)) return { success: false, error: 'INVALID_CONFIGURATION' };

  const approximate = UNITS[from].approximate || UNITS[to].approximate;
  if (from === to) return { success: true, value: quantity, approximate: false, basis: 'exact' };

  const mlOf = (u: MeasureUnit): number => (u === 'ml' ? 1 : u === 'l' ? 1000 : u === 'xic' ? cup : u === 'cs' ? TBSP_ML : TSP_ML);
  const fromDim = dimensionOf(from), toDim = dimensionOf(to);

  if (fromDim === toDim && fromDim === 'mass') return { success: true, value: quantity * GRAMS[from]! / GRAMS[to]!, approximate, basis: 'exact' };
  if (fromDim === toDim && fromDim === 'volume') return { success: true, value: quantity * mlOf(from) / mlOf(to), approximate, basis: approximate ? 'convention' : 'exact' };
  if (fromDim === 'count' && toDim === 'count') return { success: true, value: quantity, approximate: false, basis: 'exact' };

  if (fromDim === 'count' || toDim === 'count') {
    const other = fromDim === 'count' ? to : from;
    const perUnit = dimensionOf(other) === 'mass' ? gramsPerUnit : mlPerUnit;
    if (perUnit === undefined) return { success: false, error: 'MISSING_UNIT_EQUIVALENCE' };
    const value = fromDim === 'count'
      ? (dimensionOf(other) === 'mass' ? quantity * perUnit / GRAMS[other]! : quantity * perUnit / mlOf(other))
      : (dimensionOf(other) === 'mass' ? quantity * GRAMS[other]! / perUnit : quantity * mlOf(other) / perUnit);
    return { success: true, value, approximate: true, basis: 'reference' };
  }

  // massa <-> volume: exige densidade específica do ingrediente
  if (densityGPerMl === undefined) return { success: false, error: 'MISSING_DENSITY' };
  const value = fromDim === 'volume'
    ? quantity * mlOf(from) * densityGPerMl / GRAMS[to]!
    : quantity * GRAMS[from]! / densityGPerMl / mlOf(to);
  return { success: true, value, approximate: true, basis: 'reference' };
}

/** Mensagem clara para a interface, indicando qual configuração falta. */
export function conversionErrorMessage(error: ConversionError, from: MeasureUnit, to: MeasureUnit, ingredientName?: string): string {
  const who = ingredientName ? `${ingredientName}: ` : '';
  const pair = `${unitLabel(from, 2)} em ${unitLabel(to, 2)}`;
  switch (error) {
    case 'INVALID_QUANTITY': return `${who}informe uma quantidade válida (zero ou maior).`;
    case 'MISSING_DENSITY': return ingredientName
      ? `${who}para converter ${pair}, informe no cadastro do ingrediente quanto pesa 1 xícara dele (densidade).`
      : 'Para converter entre peso e volume, escolha um ingrediente com densidade cadastrada.';
    case 'MISSING_UNIT_EQUIVALENCE': return ingredientName
      ? `${who}para converter ${pair}, informe no cadastro do ingrediente quanto pesa (ou quantos mL tem) 1 unidade dele.`
      : 'Para converter unidade em peso ou volume, escolha um ingrediente com equivalência por unidade cadastrada.';
    case 'INVALID_CONFIGURATION': return `${who}configuração de conversão inválida (densidade, equivalência ou tamanho da xícara).`;
  }
}
