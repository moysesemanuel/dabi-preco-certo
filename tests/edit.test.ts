import { describe, expect, it } from 'vitest';
import { unitChangeAffectsRecipes, updateIngredient, updateRecipe } from '../src/domain/edit';
import { recipeCost } from '../src/domain/pricing';
import type { DataSet } from '../src/domain/types';

const data: DataSet = {
  schemaVersion: 1,
  ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1000, unit: 'g', purchasePrice: 6 }],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }],
  orders: [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 5, deliveryDate: '2026-12-01', status: 'Orçamento', deposit: 0, createdAt: '2026-11-11T00:00:00Z' }],
};

describe('Edição de cadastros', () => {
  it('atualiza o ingrediente mantendo o id e recalcula o custo das receitas', () => {
    const next = updateIngredient(data, 'f', { name: 'Farinha', purchaseQuantity: 1000, unit: 'g', purchasePrice: 8 });
    expect(next.ingredients[0].id).toBe('f');
    expect(recipeCost(next.recipes[0], next.ingredients).materials).toBe(4);
  });
  it('não altera o objeto original', () => {
    updateIngredient(data, 'f', { name: 'X', purchaseQuantity: 1, unit: 'kg', purchasePrice: 1 });
    expect(data.ingredients[0].name).toBe('Farinha');
  });
  it('rejeita ingrediente inexistente', () => {
    expect(() => updateIngredient(data, 'nada', { name: 'X', purchaseQuantity: 1, unit: 'g', purchasePrice: 1 })).toThrow();
  });
  it('atualiza a receita sem tocar nas encomendas', () => {
    const next = updateRecipe(data, 'r', { ...data.recipes[0], desiredMargin: 40 });
    expect(next.recipes[0].desiredMargin).toBe(40);
    expect(next.orders).toEqual(data.orders);
  });
  it('rejeita receita inexistente', () => {
    expect(() => updateRecipe(data, 'nada', data.recipes[0])).toThrow();
  });
  it('avisa quando a troca de unidade afeta receitas', () => {
    expect(unitChangeAffectsRecipes(data, 'f', 'kg')).toBe(true);
    expect(unitChangeAffectsRecipes(data, 'f', 'g')).toBe(false);
    expect(unitChangeAffectsRecipes({ ...data, recipes: [] }, 'f', 'kg')).toBe(false);
  });
});
