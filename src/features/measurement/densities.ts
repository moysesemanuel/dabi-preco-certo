/**
 * Fachada de compatibilidade sobre o catálogo (`./catalog`): o importador de receitas continua usando `findReference`, mas agora
 * os valores vêm do catálogo verificado (USDA), com a mesma regra de correspondência por IGUALDADE (nunca por semelhança).
 */
import { DEFAULT_CUP_ML } from './convert';
import { equivalenceOf, findVariant, normalizeText, searchCatalog, nameCandidates, type CatalogItem } from './catalog';

export { normalizeText, nameCandidates };

/** Referência de um ingrediente do catálogo na apresentação padrão. `gramsPerCup` vale para a xícara de 240 mL. */
export type DensityReference = { name: string; synonyms: string[]; gramsPerCup?: number; gramsPerUnit?: number; itemId: string; variantId: string };

export const REFERENCE_DISCLAIMER = 'Valores aproximados: variam conforme o ingrediente, a marca, a compactação e a forma de medir.';

const cache = new Map<string, DensityReference>();
function toReference(item: CatalogItem): DensityReference {
  const hit = cache.get(item.id); if (hit) return hit;
  const variant = findVariant(item), eq = equivalenceOf(variant);
  const ref: DensityReference = { name: item.name, synonyms: item.synonyms, itemId: item.id, variantId: variant.id, ...(eq.densityGPerMl !== undefined ? { gramsPerCup: eq.densityGPerMl * DEFAULT_CUP_ML } : {}), ...(eq.gramsPerUnit !== undefined ? { gramsPerUnit: eq.gramsPerUnit } : {}) };
  cache.set(item.id, ref); return ref;
}

/** Procura uma referência pelo nome ou sinônimo, por igualdade (após remover qualificadores e plural). */
export function findReference(ingredientName: string): DensityReference | undefined {
  const { exact } = searchCatalog(ingredientName);
  return exact ? toReference(exact) : undefined;
}

/** Densidade de referência em g/mL (a partir de gramas por xícara de 240 mL). */
export const referenceDensity = (ref: DensityReference): number | undefined => (ref.gramsPerCup ? ref.gramsPerCup / DEFAULT_CUP_ML : undefined);

/** Densidade em g/mL a partir de "1 xícara pesa X g" para um tamanho de xícara. */
export const gramsPerCupToDensity = (gramsPerCup: number, cupSizeMl = DEFAULT_CUP_ML) => gramsPerCup / cupSizeMl;
export const densityToGramsPerCup = (densityGPerMl: number, cupSizeMl = DEFAULT_CUP_ML) => densityGPerMl * cupSizeMl;
