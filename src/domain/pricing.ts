import type { Ingredient, MeasureUnit, Recipe, Unit } from './types';
export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
export const CUP_ML = 240;
const VOLUME_ML: Record<string, number | undefined> = { ml: 1, l: 1000, xic: CUP_ML, cs: 15, cc: 5 };
const MASS_G: Record<string, number | undefined> = { g: 1, kg: 1000 };
export const measureLabels: Record<MeasureUnit, string> = { g: 'g', kg: 'kg', ml: 'ml', l: 'l', un: 'un', xic: 'xícara', cs: 'colher de sopa', cc: 'colher de chá' };
/** Unidades que podem ser usadas na receita para um ingrediente comprado em `purchaseUnit`. */
export function measureOptions(purchaseUnit: Unit): MeasureUnit[] {
  if (purchaseUnit === 'g' || purchaseUnit === 'kg') return ['g', 'kg', 'xic', 'cs', 'cc'];
  if (purchaseUnit === 'ml' || purchaseUnit === 'l') return ['ml', 'l', 'xic', 'cs', 'cc'];
  return ['un'];
}
/** Converte entre peso, volume e unidades culinárias. Volume↔peso exige gramsPerCup (g por xícara de 240 ml). */
export function convertQuantity(quantity: number, from: MeasureUnit, to: MeasureUnit, gramsPerCup?: number): number {
  if (from === to) return quantity;
  const fv = VOLUME_ML[from], tv = VOLUME_ML[to], fm = MASS_G[from], tm = MASS_G[to];
  if (fv && tv) return quantity * fv / tv;
  if (fm && tm) return quantity * fm / tm;
  if ((fv && tm) || (fm && tv)) {
    if (!gramsPerCup || !(gramsPerCup > 0)) throw new Error('Informe no cadastro do ingrediente quanto pesa 1 xícara dele.');
    if (fv && tm) return quantity * fv * gramsPerCup / CUP_ML / tm;
    return quantity * fm! * CUP_ML / gramsPerCup / tv!;
  }
  throw new Error('Unidades incompatíveis.');
}
export const normalizeQuantity = (quantity: number, from: Unit, to: Unit): number => convertQuantity(quantity, from, to);
export function recipeCost(recipe: Recipe, ingredients: Ingredient[]) {
  if (!Number.isFinite(recipe.yield) || recipe.yield <= 0) throw new Error('Rendimento deve ser maior que zero.');
  if (recipe.desiredMargin < 0 || recipe.desiredMargin >= 100) throw new Error('Margem deve ficar entre 0 e 99,99%.');
  const materials = recipe.items.reduce((total, item) => {
    const ingredient = ingredients.find((i) => i.id === item.ingredientId);
    if (!ingredient) throw new Error('Ingrediente não encontrado.');
    if (ingredient.purchaseQuantity <= 0 || item.quantity < 0 || ingredient.purchasePrice < 0) throw new Error('Quantidade ou custo inválido.');
    const quantity = convertQuantity(item.quantity, item.unit ?? ingredient.unit, ingredient.unit, ingredient.gramsPerCup);
    return total + ingredient.purchasePrice / ingredient.purchaseQuantity * quantity;
  }, 0);
  const packaging = recipe.packagingPerUnit * recipe.yield;
  const total = materials + packaging + recipe.laborTotal + recipe.extraTotal;
  if (![materials, packaging, total].every(Number.isFinite) || total < 0) throw new Error('Valores inválidos.');
  const costPerUnit = total / recipe.yield;
  const suggestedPrice = costPerUnit / (1 - recipe.desiredMargin / 100);
  return { materials: round2(materials), packaging: round2(packaging), labor: round2(recipe.laborTotal), extras: round2(recipe.extraTotal), total: round2(total), costPerUnit: round2(costPerUnit), suggestedPrice: round2(suggestedPrice) };
}
export const money = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
