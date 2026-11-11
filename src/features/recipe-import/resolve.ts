import type { Ingredient, MeasureUnit, RecipeItem } from '../../domain/types';
import { convert, conversionErrorMessage, DEFAULT_CUP_ML, type ConversionResult } from '../measurement/convert';
import { findReference, nameCandidates, referenceDensity, type DensityReference } from '../measurement/densities';
import { dimensionOf, formatQuantity, unitLabel } from '../measurement/units';
import type { ParsedLine } from './parse';

/** Linha editável da tabela de importação. Os campos de texto são o que a pessoa vê e pode corrigir. */
export type ImportRow = { id: number; parsed: ParsedLine; quantity: string; unit: MeasureUnit | ''; ingredientId: string; include: boolean };
export type EquivalencePatch = { ingredientId: string; name: string; patch: { densityGPerMl?: number; gramsPerUnit?: number }; description: string };

export type RowAnalysis = {
  ingredient?: Ingredient;
  reference?: DensityReference;
  /** Peso estimado (g) e volume (mL) da medida original, quando for possível calcular. */
  grams?: number;
  ml?: number;
  approximate: boolean;
  /** De onde veio cada equivalência usada, em português. */
  references: string[];
  /** Impedem a importação da linha. */
  issues: string[];
  /** Informativos. */
  warnings: string[];
  /** Item de receita pronto (medida original preservada) quando a linha pode ser importada. */
  item?: RecipeItem;
  /** Equivalências de referência que seriam gravadas no cadastro do ingrediente ao confirmar. */
  patch?: EquivalencePatch;
  ready: boolean;
};

const toNumber = (text: string): number | undefined => {
  const t = text.trim();
  if (!t) return undefined;
  return Number(t.replace(',', '.'));
};

/** Procura o ingrediente cadastrado pelo nome, ou por um sinônimo que aponte para a mesma referência. */
export function matchRegistered(name: string, ingredients: Ingredient[]): Ingredient | undefined {
  const cands = nameCandidates(name);
  if (!cands.length) return undefined;
  const exact = ingredients.find(i => nameCandidates(i.name).some(c => cands.includes(c)));
  if (exact) return exact;
  const ref = findReference(name);
  return ref ? ingredients.find(i => findReference(i.name) === ref) : undefined;
}

export function rowFromParsed(parsed: ParsedLine, id: number, ingredients: Ingredient[]): ImportRow {
  return {
    id, parsed,
    quantity: parsed.quantity === undefined ? '' : String(Number(parsed.quantity.toFixed(4))).replace('.', ','),
    unit: parsed.unit ?? '',
    ingredientId: matchRegistered(parsed.name, ingredients)?.id ?? '',
    include: true,
  };
}

const ok = (r: ConversionResult) => (r.success ? r : undefined);

export function analyzeRow(row: ImportRow, ingredients: Ingredient[], cupSizeMl: number = DEFAULT_CUP_ML): RowAnalysis {
  const { parsed } = row;
  const issues: string[] = [];
  const warnings: string[] = [];
  const references: string[] = [];
  const quantity = toNumber(row.quantity);
  const unit = row.unit === '' ? undefined : row.unit;

  if (quantity === undefined) issues.push(parsed.indefinite ? 'Quantidade indefinida: informe a quantidade a usar.' : 'Informe a quantidade.');
  else if (!Number.isFinite(quantity) || quantity < 0) issues.push('Quantidade inválida.');
  if (!unit) issues.push(parsed.unitLabel ? `Medida "${parsed.unitLabel}" sem equivalência padrão: escolha uma medida e ajuste a quantidade.` : 'Escolha a medida.');

  const ingredient = ingredients.find(i => i.id === row.ingredientId);
  const reference = findReference(parsed.name) ?? (ingredient ? findReference(ingredient.name) : undefined);
  const refDensity = reference ? referenceDensity(reference) : undefined;
  // O cadastro do ingrediente tem prioridade sobre a referência aproximada.
  const density = ingredient?.densityGPerMl ?? refDensity;
  const densitySource = ingredient?.densityGPerMl !== undefined ? 'cadastro do ingrediente' : 'referência aproximada';
  const gramsPerUnit = ingredient?.gramsPerUnit ?? reference?.gramsPerUnit;
  const unitSource = ingredient?.gramsPerUnit !== undefined ? 'cadastro do ingrediente' : 'referência aproximada';

  const valid = quantity !== undefined && Number.isFinite(quantity) && quantity >= 0 && unit !== undefined;
  let grams: number | undefined, ml: number | undefined, approximate = false;
  if (valid) {
    const dim = dimensionOf(unit);
    const to = (target: MeasureUnit) => ok(convert({ quantity, from: unit, to: target, densityGPerMl: density, gramsPerUnit, cupSizeMl }));
    if (dim === 'volume') {
      const v = to('ml'); ml = v?.value; approximate ||= !!v?.approximate;
      const g = density !== undefined ? to('g') : undefined; grams = g?.value; approximate ||= !!g?.approximate;
      if (g && density !== undefined) {
        const one = ok(convert({ quantity: 1, from: unit, to: 'g', densityGPerMl: density, cupSizeMl }));
        if (one) references.push(`1 ${unitLabel(unit, 1)} de ${parsed.name || 'ingrediente'} ≈ ${formatQuantity(one.value, 'g')} g (${densitySource})`);
      } else warnings.push('Sem densidade: não foi possível estimar o peso.');
    } else if (dim === 'mass') {
      const g = to('g'); grams = g?.value;
    } else {
      const g = gramsPerUnit !== undefined ? to('g') : undefined; grams = g?.value; approximate ||= !!g?.approximate;
      if (g && gramsPerUnit !== undefined) references.push(`1 unidade de ${parsed.name || 'ingrediente'} ≈ ${formatQuantity(gramsPerUnit, 'g')} g (${unitSource})`);
      else warnings.push('Sem peso por unidade: não foi possível estimar o peso.');
    }
  }

  let item: RecipeItem | undefined;
  let patch: EquivalencePatch | undefined;
  if (!ingredient) {
    issues.push(reference ? `"${parsed.name}" não está cadastrado: cadastre em Ingredientes ou escolha um ingrediente cadastrado.` : `Ingrediente "${parsed.name}" não reconhecido: escolha um ingrediente cadastrado.`);
  } else if (valid) {
    const r = convert({ quantity, from: unit, to: ingredient.unit, densityGPerMl: density, gramsPerUnit, cupSizeMl });
    if (!r.success) {
      issues.push(conversionErrorMessage(r.error, unit, ingredient.unit, ingredient.name));
    } else {
      item = { ingredientId: ingredient.id, quantity, unit };
      if (dimensionOf(unit) !== dimensionOf(ingredient.unit)) {
        const counting = dimensionOf(unit) === 'count' || dimensionOf(ingredient.unit) === 'count';
        if (counting && ingredient.gramsPerUnit === undefined && reference?.gramsPerUnit !== undefined) {
          patch = { ingredientId: ingredient.id, name: ingredient.name, patch: { gramsPerUnit: reference.gramsPerUnit }, description: `1 unidade ≈ ${formatQuantity(reference.gramsPerUnit, 'g')} g` };
        } else if (!counting && ingredient.densityGPerMl === undefined && refDensity !== undefined) {
          patch = { ingredientId: ingredient.id, name: ingredient.name, patch: { densityGPerMl: refDensity }, description: `1 xícara (${cupSizeMl} mL) ≈ ${formatQuantity(refDensity * cupSizeMl, 'g')} g` };
        }
      }
    }
  }

  return { ingredient, reference, grams, ml, approximate, references, issues, warnings, item, patch, ready: issues.length === 0 && item !== undefined };
}

/** Só linhas marcadas e completas viram itens de receita; nunca entram com custo zero ou conversão incompleta. */
export function buildImport(rows: ImportRow[], ingredients: Ingredient[], cupSizeMl: number = DEFAULT_CUP_ML) {
  const items: RecipeItem[] = [];
  const patches = new Map<string, EquivalencePatch>();
  let blocked = 0;
  for (const row of rows) {
    if (!row.include) continue;
    const a = analyzeRow(row, ingredients, cupSizeMl);
    if (!a.ready || !a.item) { blocked++; continue; }
    items.push(a.item);
    if (a.patch) {
      const prev = patches.get(a.patch.ingredientId);
      patches.set(a.patch.ingredientId, prev ? { ...prev, patch: { ...a.patch.patch, ...prev.patch } } : a.patch);
    }
  }
  return { items, patches: [...patches.values()], blocked };
}
