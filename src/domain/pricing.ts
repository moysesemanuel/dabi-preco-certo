import { convert, conversionErrorMessage, DEFAULT_CUP_ML } from '../features/measurement/convert';
import { effectiveEquivalence } from './equivalence';
import type { Ingredient, MeasureUnit, Recipe } from './types';
import type { Packaging } from './types';
import { recipePackagingCostPerUnit } from './packaging';
/** Corrects binary representation noise at cent boundaries without truncating valid half-cent totals. */
export const round2 = (v: number): number => Math.round((v + Math.sign(v) * Number.EPSILON * Math.max(1, Math.abs(v))) * 100) / 100;
/** Linha de custo: preserva a medida original da receita e a quantidade convertida usada no cálculo. */
export type CostLine = { ingredientId: string; name: string; quantity: number; unit: MeasureUnit; convertedQuantity: number; convertedUnit: Ingredient['unit']; approximate: boolean; cost: number };

/** Lança Error com mensagem em português quando uma conversão necessária não é possível (nunca assume custo zero). */
export function recipeCost(recipe: Recipe, ingredients: Ingredient[], cupSizeMl: number = DEFAULT_CUP_ML, packagings: Packaging[] = []) {
  if (!Number.isFinite(recipe.yield) || recipe.yield <= 0) throw new Error('Rendimento deve ser maior que zero.');
  if (recipe.desiredMargin < 0 || recipe.desiredMargin >= 100) throw new Error('Margem deve ficar entre 0 e 99,99%.');
  const lines: CostLine[] = recipe.items.map((item) => {
    const ingredient = ingredients.find((i) => i.id === item.ingredientId);
    if (!ingredient) throw new Error('Ingrediente não encontrado.');
    if (ingredient.purchaseQuantity <= 0 || item.quantity < 0 || ingredient.purchasePrice < 0) throw new Error('Quantidade ou custo inválido.');
    const unit = item.unit ?? ingredient.unit;
    const eq = effectiveEquivalence(ingredient); // o valor informado pelo usuário tem prioridade sobre a referência do catálogo
    const converted = convert({ quantity: item.quantity, from: unit, to: ingredient.unit, densityGPerMl: eq.densityGPerMl, gramsPerUnit: eq.gramsPerUnit, cupSizeMl });
    if (!converted.success) throw new Error(conversionErrorMessage(converted.error, unit, ingredient.unit, ingredient.name));
    return { ingredientId: ingredient.id, name: ingredient.name, quantity: item.quantity, unit, convertedQuantity: converted.value, convertedUnit: ingredient.unit, approximate: converted.approximate, cost: ingredient.purchasePrice / ingredient.purchaseQuantity * converted.value };
  });
  const materials = lines.reduce((total, line) => total + line.cost, 0);
  const packagingPerUnit = recipe.packagingPerUnit + recipePackagingCostPerUnit(recipe.packagingItems, packagings);
  const packaging = packagingPerUnit * recipe.yield;
  const total = materials + packaging + recipe.laborTotal + recipe.extraTotal;
  if (![materials, packaging, total].every(Number.isFinite) || total < 0) throw new Error('Valores inválidos.');
  const costPerUnit = total / recipe.yield;
  const suggestedPrice = costPerUnit / (1 - recipe.desiredMargin / 100);
  return { lines, materials: round2(materials), packaging: round2(packaging), labor: round2(recipe.laborTotal), extras: round2(recipe.extraTotal), total: round2(total), costPerUnitExact: costPerUnit, costPerUnit: round2(costPerUnit), suggestedPrice: round2(suggestedPrice) };
}
export const money = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
export const moneyPrecise = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(v);
