import { DEFAULT_CUP_ML } from './convert';

/**
 * Referências culinárias aproximadas. `gramsPerCup` vale para xícara de 240 mL; `gramsPerUnit` é o peso de 1 unidade.
 * Variam conforme marca, compactação e técnica de medição; o cadastro do ingrediente sempre tem prioridade.
 */
export type DensityReference = { name: string; synonyms: string[]; gramsPerCup?: number; gramsPerUnit?: number };

export const DENSITY_REFERENCES: DensityReference[] = [
  { name: 'Farinha de trigo', synonyms: [], gramsPerCup: 120 },
  { name: 'Açúcar refinado', synonyms: ['açúcar', 'açúcar branco'], gramsPerCup: 200 },
  { name: 'Açúcar de confeiteiro', synonyms: ['açúcar impalpável', 'açúcar de confeitar'], gramsPerCup: 120 },
  { name: 'Manteiga', synonyms: [], gramsPerCup: 227 },
  { name: 'Óleo vegetal', synonyms: ['óleo', 'óleo de soja'], gramsPerCup: 221 },
  { name: 'Água', synonyms: [], gramsPerCup: 240 },
  { name: 'Leite integral', synonyms: ['leite', 'leite de vaca'], gramsPerCup: 247 },
  { name: 'Ovo', synonyms: ['ovo inteiro', 'ovo de galinha'], gramsPerUnit: 50 },
  // 1 colher de sopa (15 mL) ≈ 12 g  →  0,8 g/mL  →  192 g por xícara de 240 mL
  { name: 'Fermento químico', synonyms: ['fermento em pó', 'fermento químico em pó', 'fermento quimico', 'pó royal', 'fermento royal', 'royal'], gramsPerCup: 192 },
];

export const REFERENCE_DISCLAIMER = 'Valores aproximados: variam conforme o ingrediente, a marca, a compactação e a forma de medir.';

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

/**
 * Procura uma referência pelo nome ou sinônimo, por igualdade (após remover qualificadores e plural).
 * Nunca "adivinha" por semelhança: "leite condensado" não casa com "leite".
 */
export function findReference(ingredientName: string): DensityReference | undefined {
  const cands = nameCandidates(ingredientName);
  if (!cands.length) return undefined;
  return DENSITY_REFERENCES.find(r => [r.name, ...r.synonyms].some(alias => cands.includes(normalizeText(alias))));
}

/** Densidade de referência em g/mL (a partir de gramas por xícara de 240 mL). */
export const referenceDensity = (ref: DensityReference): number | undefined => (ref.gramsPerCup ? ref.gramsPerCup / DEFAULT_CUP_ML : undefined);

/** Densidade em g/mL a partir de "1 xícara pesa X g" para um tamanho de xícara. */
export const gramsPerCupToDensity = (gramsPerCup: number, cupSizeMl = DEFAULT_CUP_ML) => gramsPerCup / cupSizeMl;
export const densityToGramsPerCup = (densityGPerMl: number, cupSizeMl = DEFAULT_CUP_ML) => densityGPerMl * cupSizeMl;
