import { captureCostSnapshot } from './orderCost';
import { isMoney, isPositiveQuantity, toCents2 } from './money';
import { orderTotal, totalReceived } from './payments';
import type { CatalogRef, DataSet, Ingredient, Order, Recipe } from './types';

export type IngredientPatch = Omit<Ingredient, 'id'>;
export type RecipePatch = Omit<Recipe, 'id'>;

/** Substitui os dados de um ingrediente. Receitas continuam apontando pelo mesmo id. */
export function updateIngredient(data: DataSet, id: string, patch: IngredientPatch): DataSet {
  if (!data.ingredients.some(i => i.id === id)) throw new Error('Ingrediente não encontrado.');
  return { ...data, ingredients: data.ingredients.map(i => (i.id === id ? { ...patch, id } : i)) };
}

/** Substitui os dados de uma receita. Encomendas existentes não são alteradas. */
export function updateRecipe(data: DataSet, id: string, patch: RecipePatch): DataSet {
  if (!data.recipes.some(r => r.id === id)) throw new Error('Receita não encontrada.');
  return { ...data, recipes: data.recipes.map(r => (r.id === id ? { ...patch, id } : r)) };
}

export type OrderPatch = Pick<Order, 'customer' | 'recipeId' | 'quantity' | 'unitPrice' | 'deliveryDate' | 'deposit'> & Partial<Pick<Order, 'packagingItems' | 'packagingCharge'>>;

/**
 * Atualiza os dados de uma encomenda. Status, data de criação e id são preservados.
 * O custo registrado (`costSnapshot`) é mantido; só é refeito se a RECEITA da encomenda mudar, porque aí o
 * pedido passa a ser de outro produto (se o custo não puder ser calculado, o registro é removido: nunca se inventa custo).
 */
export function updateOrder(data: DataSet, id: string, patch: OrderPatch, now: Date = new Date()): DataSet {
  if (!data.orders.some(o => o.id === id)) throw new Error('Encomenda não encontrada.');
  if (!data.recipes.some(r => r.id === patch.recipeId)) throw new Error('Receita não encontrada.');
  if (!patch.customer.trim() || !patch.deliveryDate) throw new Error('Informe cliente e data de entrega.');
  if (!isPositiveQuantity(patch.quantity) || !isMoney(patch.unitPrice) || !isMoney(patch.deposit) || (patch.packagingCharge !== undefined && !isMoney(patch.packagingCharge))) throw new Error('Quantidade, preço, sinal ou cobrança de embalagens inválida.');
  const existing = data.orders.find(o => o.id === id)!;
  const unitPrice = toCents2(patch.unitPrice), deposit = toCents2(patch.deposit);
  const packagingCharge = toCents2(patch.packagingCharge ?? existing.packagingCharge ?? 0);
  const normalizedPatch = { ...patch, unitPrice, deposit, packagingCharge };
  const total = orderTotal(normalizedPatch);
  if (deposit > total) throw new Error('O sinal não pode ser maior que o total.');
  // Sem crédito nem reembolso: o novo total não pode ficar abaixo do que já foi recebido.
  const received = totalReceived({ deposit, payments: existing.payments });
  if (received > total) throw new Error('O total não pode ficar abaixo do que já foi recebido.');
  const current = data.orders.find(o => o.id === id)!;
  const recipeChanged = current.recipeId !== patch.recipeId;
  return {
    ...data,
    orders: data.orders.map(o => {
      if (o.id !== id) return o;
      const { costSnapshot, ...rest } = o;
      const next = { ...rest, ...normalizedPatch, ...(patch.packagingItems ? { packagingItems: patch.packagingItems } : {}), customer: patch.customer.trim() };
      if (!recipeChanged) return costSnapshot ? { ...next, costSnapshot } : next;
      const snap = captureCostSnapshot(data.recipes.find(r => r.id === patch.recipeId)!, data, now);
      return snap ? { ...next, costSnapshot: snap } : next;
    }),
  };
}

/** Remove uma encomenda. Receitas e ingredientes não são alterados (a receita volta a poder ser excluída se não tiver outras encomendas). */
export function removeOrder(data: DataSet, id: string): DataSet {
  if (!data.orders.some(o => o.id === id)) throw new Error('Encomenda não encontrada.');
  return { ...data, orders: data.orders.filter(o => o.id !== id) };
}

/**
 * Adota referências do catálogo em ingredientes que ainda não têm uma (nunca troca uma referência existente nem mexe nos valores
 * informados pelo usuário, que têm prioridade nos cálculos).
 */
export function applyEquivalences(data: DataSet, patches: { ingredientId: string; patch: { catalogRef?: CatalogRef } }[]): DataSet {
  return patches.reduce((acc, { ingredientId, patch }) => {
    const current = acc.ingredients.find(i => i.id === ingredientId);
    if (!current || current.catalogRef || !patch.catalogRef) return acc;
    const { id: _id, ...rest } = current;
    return updateIngredient(acc, ingredientId, { ...rest, catalogRef: patch.catalogRef });
  }, data);
}

/** True se mudar a unidade do ingrediente pode distorcer receitas antigas, cujos itens não guardam unidade própria. */
export function unitChangeAffectsRecipes(data: DataSet, id: string, newUnit: Ingredient['unit']): boolean {
  const current = data.ingredients.find(i => i.id === id);
  return !!current && current.unit !== newUnit && data.recipes.some(r => r.items.some(i => i.ingredientId === id && !i.unit));
}
