import type { DataSet, Ingredient, Order, Recipe } from './types';

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

export type OrderPatch = Pick<Order, 'customer' | 'recipeId' | 'quantity' | 'unitPrice' | 'deliveryDate' | 'deposit'>;

/** Atualiza os dados de uma encomenda. Status, data de criação e id são preservados. */
export function updateOrder(data: DataSet, id: string, patch: OrderPatch): DataSet {
  if (!data.orders.some(o => o.id === id)) throw new Error('Encomenda não encontrada.');
  if (!data.recipes.some(r => r.id === patch.recipeId)) throw new Error('Receita não encontrada.');
  if (!patch.customer.trim() || !patch.deliveryDate) throw new Error('Informe cliente e data de entrega.');
  if (![patch.quantity, patch.unitPrice, patch.deposit].every(Number.isFinite) || !(patch.quantity > 0) || patch.unitPrice < 0 || patch.deposit < 0) throw new Error('Quantidade, preço ou sinal inválido.');
  if (patch.deposit > patch.quantity * patch.unitPrice) throw new Error('O sinal não pode ser maior que o total.');
  return { ...data, orders: data.orders.map(o => (o.id === id ? { ...o, ...patch, customer: patch.customer.trim() } : o)) };
}

/** Remove uma encomenda. Receitas e ingredientes não são alterados (a receita volta a poder ser excluída se não tiver outras encomendas). */
export function removeOrder(data: DataSet, id: string): DataSet {
  if (!data.orders.some(o => o.id === id)) throw new Error('Encomenda não encontrada.');
  return { ...data, orders: data.orders.filter(o => o.id !== id) };
}

/** Grava equivalências de referência em ingredientes, preenchendo só o que ainda está em branco (nunca sobrescreve). */
export function applyEquivalences(data: DataSet, patches: { ingredientId: string; patch: { densityGPerMl?: number; gramsPerUnit?: number } }[]): DataSet {
  return patches.reduce((acc, { ingredientId, patch }) => {
    const current = acc.ingredients.find(i => i.id === ingredientId);
    if (!current) return acc;
    const { id: _id, ...rest } = current;
    return updateIngredient(acc, ingredientId, {
      ...rest,
      ...(current.densityGPerMl === undefined && patch.densityGPerMl !== undefined ? { densityGPerMl: patch.densityGPerMl } : {}),
      ...(current.gramsPerUnit === undefined && patch.gramsPerUnit !== undefined ? { gramsPerUnit: patch.gramsPerUnit } : {}),
    });
  }, data);
}

/** True se mudar a unidade do ingrediente pode distorcer receitas antigas, cujos itens não guardam unidade própria. */
export function unitChangeAffectsRecipes(data: DataSet, id: string, newUnit: Ingredient['unit']): boolean {
  const current = data.ingredients.find(i => i.id === id);
  return !!current && current.unit !== newUnit && data.recipes.some(r => r.items.some(i => i.ingredientId === id && !i.unit));
}
