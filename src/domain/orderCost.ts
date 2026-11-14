import { recipeCost } from './pricing';
import type { CostSnapshot, DataSet, Order, OrderItem, Recipe } from './types';
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

/** Custo unitário de UM item: o registrado (snapshot do item) ou, sem registro, uma estimativa com os preços atuais da receita. */
export function itemUnitCost(item: OrderItem, data: DataSet): OrderCost {
  if (item.costSnapshot) return { basis: 'recorded', costPerUnit: item.costSnapshot.costPerUnit };
  const recipe = data.recipes.find(r => r.id === item.recipeId);
  if (!recipe) return { basis: 'unavailable' };
  try { return { basis: 'estimated', costPerUnit: recipeCost(recipe, data.ingredients, cupSize(data), data.packagings ?? []).costPerUnit }; } catch { return { basis: 'unavailable' }; }
}

/** Base do custo da encomenda inteira: indisponível se algum item não tem custo; estimada se algum item não tem registro. */
export function orderCostBasis(order: Order, data: DataSet): OrderCost['basis'] {
  const bases = order.items.map(item => itemUnitCost(item, data).basis);
  return bases.includes('unavailable') ? 'unavailable' : bases.includes('estimated') ? 'estimated' : 'recorded';
}

/** Itens no formato do cálculo financeiro, com o custo unitário de cada um (registrado ou estimado). */
export const financialItems = (order: Order, data: DataSet) => order.items.map(item => {
  const cost = itemUnitCost(item, data);
  return { quantity: item.quantity, unitPrice: item.unitPrice, ...(cost.basis === 'unavailable' ? {} : { costPerUnit: cost.costPerUnit }) };
});

/** Total dos adicionais congelados na encomenda; a lista é a única fonte de verdade. */
export function orderPackagingTotal(order: Pick<Order, 'packagingItems'>): number {
  return (order.packagingItems ?? []).reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
}
/** Custo total: Σ custo dos itens (cada um com as embalagens da SUA receita) + embalagens adicionais. Indefinido se algum item não tem custo. */
export function orderTotalCost(order: Order, data: DataSet): number | undefined {
  let total = 0;
  for (const item of order.items) {
    const cost = itemUnitCost(item, data);
    if (cost.basis === 'unavailable') return undefined;
    total += cost.costPerUnit * item.quantity;
  }
  return total + orderPackagingTotal(order);
}
