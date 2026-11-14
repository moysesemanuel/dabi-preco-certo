/**
 * Catálogo local (sem rede) de equivalências culinárias + busca segura por nome.
 * Fonte dos pesos: USDA FoodData Central, SR Legacy (domínio público, CC0 1.0). Veja docs/CATALOGO_DE_MEDIDAS.md.
 * Valores são aproximados: variam com marca, compactação e forma de medir. Nada aqui é inventado ou estimado por IA.
 */
import type { CatalogRef } from '../../../domain/types';
import { CATALOG_ITEMS } from './data';
import type { CatalogItem, CatalogVariant, UnitMeasure, VolumeMeasure } from './types';

export type { CatalogItem, CatalogMeasure, CatalogVariant, UnitMeasure, VolumeMeasure } from './types';
/** Muda sempre que qualquer valor, nome ou sinônimo do catálogo mudar. */
export const CATALOG_VERSION = '2026.11.1';
export const CATALOG_SOURCE = { name: 'USDA FoodData Central, SR Legacy (abril/2018)', license: 'Domínio público (CC0 1.0)', url: 'https://fdc.nal.usda.gov/' } as const;
export const CATALOG: readonly CatalogItem[] = CATALOG_ITEMS;

/** Minúsculas, sem acentos nem pontuação, com espaços simples. */
export const normalizeText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const QUALIFIERS = new Set(['peneirada', 'peneirado', 'derretida', 'derretido', 'amolecida', 'amolecido', 'gelada', 'gelado', 'fria', 'frio', 'morna', 'morno', 'quente', 'grande', 'grandes', 'medio', 'medios', 'media', 'medias', 'pequeno', 'pequenos']);
/** Remove adjetivos de preparo/tamanho ("peneirada", "grandes", "sem sal") que não mudam o ingrediente. */
function stripQualifiers(normalized: string): string {
  const base = normalized.replace(/\bem temperatura ambiente\b/g, ' ').replace(/\b(sem|com) sal\b/g, ' ');
  return base.split(' ').filter(w => w && !QUALIFIERS.has(w)).join(' ');
}
/** Candidatos de comparação para um nome: sem qualificadores, e com a última palavra no singular ("ovos" → "ovo"). */
export function nameCandidates(name: string): string[] {
  const base = stripQualifiers(normalizeText(name));
  if (!base) return [];
  const words = base.split(' ');
  const last = words[words.length - 1];
  const singular = last.length > 3 && last.endsWith('s') ? [...words.slice(0, -1), last.slice(0, -1)].join(' ') : base;
  return singular === base ? [base] : [base, singular];
}

const aliasesOf = (item: CatalogItem) => [item.name, ...item.synonyms].map(normalizeText);
const BY_ID = new Map(CATALOG.map(i => [i.id, i]));
export const findItem = (id: string): CatalogItem | undefined => BY_ID.get(id);
export const findVariant = (item: CatalogItem, variantId?: string): CatalogVariant => item.variants.find(v => v.id === variantId) ?? item.variants.find(v => v.default) ?? item.variants[0];

export type CatalogSearch = {
  /** Correspondência por IGUALDADE com o nome ou sinônimo (após remover plural e adjetivos de preparo). Seguro para sugerir direto. */
  exact?: CatalogItem;
  /** Itens cujo nome/sinônimo contém todas as palavras digitadas (início de palavra). O usuário precisa confirmar: nunca são aplicados sozinhos. */
  suggestions: CatalogItem[];
};

/** Nunca "adivinha" por semelhança: "leite condensado" não casa com "leite"; "farinha" só sugere, não escolhe. */
export function searchCatalog(query: string, limit = 8): CatalogSearch {
  const cands = nameCandidates(query);
  if (!cands.length) return { suggestions: [] };
  const exact = CATALOG.find(i => aliasesOf(i).some(a => cands.includes(a)));
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (!tokens.length || normalizeText(query).length < 2) return { exact, suggestions: [] };
  const matches = (alias: string) => tokens.every(t => alias.split(' ').some(w => w.startsWith(t)));
  const rank = (i: CatalogItem) => (aliasesOf(i).some(a => a.startsWith(tokens.join(' '))) ? 0 : 1);
  const suggestions = CATALOG.filter(i => i !== exact && aliasesOf(i).some(matches)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'pt-BR')).slice(0, limit);
  return { exact, suggestions };
}

/** Densidade (g/mL) e peso por unidade (g) de uma apresentação. A medida de referência preferida é a xícara; depois colher de sopa, colher de chá e mL. */
export type CatalogEquivalence = { densityGPerMl?: number; gramsPerUnit?: number; measureUnit?: VolumeMeasure['unit']; unitLabel?: string };
export function equivalenceOf(variant: CatalogVariant): CatalogEquivalence {
  const order: VolumeMeasure['unit'][] = ['cup', 'tbsp', 'tsp', 'ml'];
  const vol = order.map(u => variant.measures.find((m): m is VolumeMeasure => m.kind === 'volume' && m.unit === u)).find(Boolean);
  const unit = variant.measures.find((m): m is UnitMeasure => m.kind === 'unit');
  return { ...(vol ? { densityGPerMl: vol.grams / vol.refVolumeMl, measureUnit: vol.unit } : {}), ...(unit ? { gramsPerUnit: unit.grams, unitLabel: unit.label } : {}) };
}

/** Referência adotada por um ingrediente: congela os valores e a versão do catálogo, para que atualizações futuras nunca mudem custos sozinhas. */
export function makeRef(itemId: string, variantId?: string): CatalogRef | undefined {
  const item = findItem(itemId); if (!item) return undefined;
  const variant = findVariant(item, variantId);
  const eq = equivalenceOf(variant);
  return { id: item.id, variant: variant.id, version: CATALOG_VERSION, ...(eq.densityGPerMl !== undefined ? { densityGPerMl: eq.densityGPerMl } : {}), ...(eq.gramsPerUnit !== undefined ? { gramsPerUnit: eq.gramsPerUnit } : {}) };
}

/** Os valores atuais do catálogo para a referência adotada diferem dos congelados? (só então vale oferecer "atualizar"). */
export function refDiffersFromCatalog(ref: CatalogRef): boolean {
  const cur = makeRef(ref.id, ref.variant); if (!cur) return false;
  const close = (a?: number, b?: number) => (a === undefined || b === undefined ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
  return !close(cur.densityGPerMl, ref.densityGPerMl) || !close(cur.gramsPerUnit, ref.gramsPerUnit);
}

export const itemAndVariant = (ref: CatalogRef): { item: CatalogItem; variant: CatalogVariant } | undefined => {
  const item = findItem(ref.id); return item ? { item, variant: findVariant(item, ref.variant) } : undefined;
};
