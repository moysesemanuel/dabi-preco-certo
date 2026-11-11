import { recipeCost, round2 } from './pricing';
import type { CostSnapshot, DataSet, Order, Recipe } from './types';
import { DEFAULT_CUP_ML } from '../features/measurement/convert';

const cupSize = (d: DataSet) => d.settings?.cupSizeMl ?? DEFAULT_CUP_ML;

/** Registra o custo unitário atual da receita. Devolve undefined se o custo não puder ser calculado (nunca assume zero). */
export function captureCostSnapshot(recipe: Recipe, data: DataSet, now: Date = new Date()): CostSnapshot | undefined {
  try { return { costPerUnit: round2(recipeCost(recipe, data.ingredients, cupSize(data)).costPerUnit), capturedAt: now.toISOString() }; } catch { return undefined; }
}

export type OrderCost =
  /** Custo registrado quando a encomenda foi feita (fato histórico). */
  | { basis: 'recorded'; costPerUnit: number }
  /** Sem registro: calculado com os preços ATUAIS, portanto apenas uma estimativa. */
  | { basis: 'estimated'; costPerUnit: number }
  | { basis: 'unavailable' };

export function orderUnitCost(order: Order, data: DataSet): OrderCost {
  if (order.costSnapshot) return { basis: 'recorded', costPerUnit: order.costSnapshot.costPerUnit };
  const recipe = data.recipes.find(r => r.id === order.recipeId);
  if (!recipe) return { basis: 'unavailable' };
  try { return { basis: 'estimated', costPerUnit: recipeCost(recipe, data.ingredients, cupSize(data)).costPerUnit }; } catch { return { basis: 'unavailable' }; }
}
