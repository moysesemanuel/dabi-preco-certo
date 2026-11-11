import type { Ingredient, Recipe, Unit } from './types';
export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
export function normalizeQuantity(quantity: number, from: Unit, to: Unit): number {
  if (from === to) return quantity;
  const convert: Partial<Record<Unit, { unit: Unit; multiple: number }>> = {
    kg: { unit: 'g', multiple: 1000 }, l: { unit: 'ml', multiple: 1000 },
  };
  const origin = convert[from] ? { unit: convert[from]!.unit, amount: quantity * convert[from]!.multiple } : { unit: from, amount: quantity };
  const target = convert[to] ? { unit: convert[to]!.unit, amount: convert[to]!.multiple } : { unit: to, amount: 1 };
  if (origin.unit !== target.unit) throw new Error('Unidades incompatíveis.');
  return origin.amount / target.amount;
}
export function recipeCost(recipe: Recipe, ingredients: Ingredient[]) {
  if (!Number.isFinite(recipe.yield) || recipe.yield <= 0) throw new Error('Rendimento deve ser maior que zero.');
  if (recipe.desiredMargin < 0 || recipe.desiredMargin >= 100) throw new Error('Margem deve ficar entre 0 e 99,99%.');
  const materials = recipe.items.reduce((total, item) => {
    const ingredient = ingredients.find((i) => i.id === item.ingredientId);
    if (!ingredient) throw new Error('Ingrediente não encontrado.');
    if (ingredient.purchaseQuantity <= 0 || item.quantity < 0 || ingredient.purchasePrice < 0) throw new Error('Quantidade ou custo inválido.');
    return total + ingredient.purchasePrice / ingredient.purchaseQuantity * item.quantity;
  }, 0);
  const packaging = recipe.packagingPerUnit * recipe.yield;
  const total = materials + packaging + recipe.laborTotal + recipe.extraTotal;
  if (![materials, packaging, total].every(Number.isFinite) || total < 0) throw new Error('Valores inválidos.');
  const costPerUnit = total / recipe.yield;
  const suggestedPrice = costPerUnit / (1 - recipe.desiredMargin / 100);
  return { materials: round2(materials), packaging: round2(packaging), labor: round2(recipe.laborTotal), extras: round2(recipe.extraTotal), total: round2(total), costPerUnit: round2(costPerUnit), suggestedPrice: round2(suggestedPrice) };
}
export const money = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
