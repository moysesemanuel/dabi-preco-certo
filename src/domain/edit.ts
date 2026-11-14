import type { CatalogRef, DataSet, Ingredient, Recipe } from './types';

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

export { updateOrder, type OrderPatch } from './orders';

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
