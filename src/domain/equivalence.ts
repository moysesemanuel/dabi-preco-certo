import type { Ingredient } from './types';

export type EffectiveEquivalence = {
  densityGPerMl?: number; gramsPerUnit?: number;
  /** 'custom' = valor informado pelo usuário (prioridade); 'catalog' = referência do catálogo adotada; undefined = sem equivalência. */
  densitySource?: 'custom' | 'catalog'; unitSource?: 'custom' | 'catalog';
};

/**
 * Equivalências que valem para os cálculos: o que o usuário informou tem prioridade; senão, a referência do catálogo adotada
 * (valores congelados em `catalogRef`, que nunca mudam sozinhos); senão, nenhuma (o cálculo recusa em vez de assumir).
 */
export function effectiveEquivalence(i: Pick<Ingredient, 'densityGPerMl' | 'gramsPerUnit' | 'catalogRef'>): EffectiveEquivalence {
  const density = i.densityGPerMl ?? i.catalogRef?.densityGPerMl;
  const unit = i.gramsPerUnit ?? i.catalogRef?.gramsPerUnit;
  return {
    ...(density !== undefined ? { densityGPerMl: density, densitySource: i.densityGPerMl !== undefined ? 'custom' as const : 'catalog' as const } : {}),
    ...(unit !== undefined ? { gramsPerUnit: unit, unitSource: i.gramsPerUnit !== undefined ? 'custom' as const : 'catalog' as const } : {}),
  };
}
