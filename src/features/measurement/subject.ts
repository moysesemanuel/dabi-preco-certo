/**
 * "Sujeito" de uma conversão: de que ingrediente falamos e de onde vêm as equivalências (nada é inventado).
 *  - ingrediente do usuário: valor informado por ele (prioridade) → referência do catálogo adotada → nenhuma;
 *  - item do catálogo: apresentação escolhida.
 */
import { effectiveEquivalence } from '../../domain/equivalence';
import type { Ingredient } from '../../domain/types';
import { CATALOG_SOURCE, CATALOG_VERSION, equivalenceOf, findItem, findVariant, itemAndVariant, type CatalogItem } from './catalog';

export type SubjectSource = 'custom' | 'catalog' | 'none';
export type Subject = {
  key: string;
  label: string;
  densityGPerMl?: number;
  gramsPerUnit?: number;
  /** Origem do peso por volume / do peso por unidade, para o texto "valor informado por você" × "referência". */
  densitySource: SubjectSource;
  unitSource: SubjectSource;
  /** Ingrediente cadastrado (permite "Usar na receita"). */
  ingredient?: Ingredient;
  /** Texto curto da referência do catálogo (ex.: "Farinha de trigo · Comum (branca)"), quando houver. */
  reference?: string;
  /** Como o USDA descreve a porção, para "ver fonte". */
  sourceNote?: string;
};

const refLabel = (item: CatalogItem, variantLabel: string) => (item.variants.length > 1 ? `${item.name} · ${variantLabel}` : item.name);

export function subjectFromCatalog(item: CatalogItem, variantId?: string): Subject {
  const variant = findVariant(item, variantId), eq = equivalenceOf(variant);
  return {
    key: `catalog:${item.id}:${variant.id}`, label: item.name,
    ...(eq.densityGPerMl !== undefined ? { densityGPerMl: eq.densityGPerMl } : {}), ...(eq.gramsPerUnit !== undefined ? { gramsPerUnit: eq.gramsPerUnit } : {}),
    densitySource: eq.densityGPerMl !== undefined ? 'catalog' : 'none', unitSource: eq.gramsPerUnit !== undefined ? 'catalog' : 'none',
    reference: refLabel(item, variant.label), sourceNote: sourceNote(variant.source.description, variant.source.fdcId),
  };
}

export function subjectFromIngredient(i: Ingredient): Subject {
  const eq = effectiveEquivalence(i), found = i.catalogRef ? itemAndVariant(i.catalogRef) : undefined;
  return {
    key: `ingredient:${i.id}`, label: i.name, ingredient: i,
    ...(eq.densityGPerMl !== undefined ? { densityGPerMl: eq.densityGPerMl } : {}), ...(eq.gramsPerUnit !== undefined ? { gramsPerUnit: eq.gramsPerUnit } : {}),
    densitySource: eq.densitySource ?? 'none', unitSource: eq.unitSource ?? 'none',
    ...(found ? { reference: refLabel(found.item, found.variant.label), sourceNote: sourceNote(found.variant.source.description, found.variant.source.fdcId) } : {}),
  };
}

const sourceNote = (description: string, fdcId: number) => `${CATALOG_SOURCE.name}, alimento “${description}” (FDC ${fdcId}). ${CATALOG_SOURCE.license}. Catálogo ${CATALOG_VERSION}.`;
export { findItem };
