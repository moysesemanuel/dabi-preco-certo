import { recipeCost } from './pricing';
import type { CostSnapshot, DataSet, Order, Recipe } from './types';
import { DEFAULT_CUP_ML } from '../features/measurement/convert';

const cupSize = (d: DataSet) => d.settings?.cupSizeMl ?? DEFAULT_CUP_ML;

/** Registra o custo unitário atual da receita. Devolve undefined se o custo não puder ser calculado (nunca assume zero). */
export function captureCostSnapshot(recipe: Recipe, data: DataSet, now: Date = new Date()): CostSnapshot | undefined {
  try { return { costPerUnit: recipeCost(recipe, data.ingredients, cupSize(data), data.packagings ?? []).costPerUnitExact, capturedAt: now.toISOString(), ...((recipe.packagingItems?.length ?? 0) ? { packagingItems: recipe.packagingItems!.map(item => { const p = data.packagings.find(x => x.id === item.packagingId)!; return { packagingId: p.id, name: p.name, quantityPerUnit: item.quantityPerUnit, unitCost: p.purchasePrice / p.purchaseQuantity }; }) } : {}) }; } catch { return undefined; }
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
  try { return { basis: 'estimated', costPerUnit: recipeCost(recipe, data.ingredients, cupSize(data), data.packagings ?? []).costPerUnit }; } catch { return { basis: 'unavailable' }; }
}

/** Total dos adicionais congelados na encomenda; a lista é a única fonte de verdade. */
export function orderPackagingTotal(order: Pick<Order, 'packagingItems'>): number {
  return (order.packagingItems ?? []).reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
}
export function orderTotalCost(order: Order, data: DataSet): number | undefined {
  const base = orderUnitCost(order, data);
  return base.basis === 'unavailable' ? undefined : base.costPerUnit * order.quantity + orderPackagingTotal(order);
}
