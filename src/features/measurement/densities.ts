import { DEFAULT_CUP_ML } from './convert';

/** Referências aproximadas: gramas por xícara de 240 mL. Variam conforme marca, compactação e técnica de medição. */
export const DENSITY_REFERENCES: { name: string; gramsPerCup: number }[] = [
  { name: 'Farinha de trigo', gramsPerCup: 120 },
  { name: 'Açúcar refinado', gramsPerCup: 200 },
  { name: 'Açúcar de confeiteiro', gramsPerCup: 120 },
  { name: 'Manteiga', gramsPerCup: 227 },
  { name: 'Óleo vegetal', gramsPerCup: 221 },
  { name: 'Água', gramsPerCup: 240 },
  { name: 'Leite integral', gramsPerCup: 247 },
];

export const REFERENCE_DISCLAIMER = 'Valores aproximados: variam conforme o ingrediente, a marca, a compactação e a forma de medir.';

const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Procura uma referência cujo nome coincide com o início do nome do ingrediente. Nunca "adivinha" por semelhança. */
export function findReference(ingredientName: string) {
  const n = normalize(ingredientName);
  if (!n) return undefined;
  return DENSITY_REFERENCES.find(r => n === normalize(r.name) || n.startsWith(normalize(r.name) + ' '));
}

/** Densidade em g/mL a partir de "1 xícara pesa X g" para um tamanho de xícara. */
export const gramsPerCupToDensity = (gramsPerCup: number, cupSizeMl = DEFAULT_CUP_ML) => gramsPerCup / cupSizeMl;
export const densityToGramsPerCup = (densityGPerMl: number, cupSizeMl = DEFAULT_CUP_ML) => densityGPerMl * cupSizeMl;
