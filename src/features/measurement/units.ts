import type { MeasureUnit } from '../../domain/types';

export type Dimension = 'mass' | 'volume' | 'count';

type UnitInfo = { dimension: Dimension; short: string; singular: string; plural: string; long: string; approximate: boolean };

/**
 * Definição das unidades. Os identificadores são os mesmos já gravados nos dados do app
 * (`un` = unidade, `xic` = xícara, `cs` = colher de sopa, `cc` = colher de chá).
 * Xícara e colheres são convenções culinárias, não medidas físicas exatas.
 */
export const UNITS: Record<MeasureUnit, UnitInfo> = {
  g: { dimension: 'mass', short: 'g', singular: 'g', plural: 'g', long: 'Gramas (g)', approximate: false },
  kg: { dimension: 'mass', short: 'kg', singular: 'kg', plural: 'kg', long: 'Quilogramas (kg)', approximate: false },
  ml: { dimension: 'volume', short: 'mL', singular: 'mL', plural: 'mL', long: 'Mililitros (mL)', approximate: false },
  l: { dimension: 'volume', short: 'L', singular: 'L', plural: 'L', long: 'Litros (L)', approximate: false },
  xic: { dimension: 'volume', short: 'xíc.', singular: 'xícara', plural: 'xícaras', long: 'Xícara', approximate: true },
  cs: { dimension: 'volume', short: 'col. sopa', singular: 'colher de sopa', plural: 'colheres de sopa', long: 'Colher de sopa', approximate: true },
  cc: { dimension: 'volume', short: 'col. chá', singular: 'colher de chá', plural: 'colheres de chá', long: 'Colher de chá', approximate: true },
  un: { dimension: 'count', short: 'un.', singular: 'unidade', plural: 'unidades', long: 'Unidade', approximate: false },
};

export const UNIT_ORDER: MeasureUnit[] = ['g', 'kg', 'ml', 'l', 'xic', 'cs', 'cc', 'un'];
export const dimensionOf = (u: MeasureUnit): Dimension => UNITS[u].dimension;
export const unitLabel = (u: MeasureUnit, quantity = 1): string => (quantity === 1 ? UNITS[u].singular : UNITS[u].plural);

const PRECISION: Record<MeasureUnit, number> = { g: 1, kg: 3, ml: 1, l: 3, xic: 2, cs: 2, cc: 2, un: 2 };

/** Arredonda somente para exibição, com a precisão adequada à unidade. Nunca use o resultado em cálculos. */
export function formatQuantity(value: number, unit: MeasureUnit): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: PRECISION[unit] }).format(value);
}

/** Texto curto da unidade para exibir ao lado de um número: g, kg, mL e L ficam abreviados; as demais variam no plural. */
export const unitText = (u: MeasureUnit, quantity = 1): string => (['g', 'kg', 'ml', 'l'].includes(u) ? UNITS[u].short : unitLabel(u, quantity));

/** Para exibição: valores menores que 1 kg/L aparecem em g/mL (ex.: 0,24 kg → 240 g). Não afeta cálculos. */
export function friendlyAmount(value: number, unit: MeasureUnit): { value: number; unit: MeasureUnit } {
  if (unit === 'kg' && value < 1) return { value: value * 1000, unit: 'g' };
  if (unit === 'l' && value < 1) return { value: value * 1000, unit: 'ml' };
  return { value, unit };
}
