import { describe, expect, it } from 'vitest';
import { emptyData, validateBackup } from '../src/storage/db';

const valid = () => ({
  schemaVersion: 1,
  ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1000, unit: 'g', purchasePrice: 6 }],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }],
  orders: [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 5, deliveryDate: '2026-12-01', status: 'Orçamento', deposit: 0, createdAt: '2026-11-11T00:00:00Z' }],
});

describe('validateBackup', () => {
  it('aceita um backup válido e o vazio', () => {
    expect(validateBackup(valid()).ingredients).toHaveLength(1);
    expect(validateBackup(emptyData())).toEqual(emptyData());
  });
  it('rejeita valores que não são objeto', () => {
    expect(() => validateBackup(null)).toThrow();
    expect(() => validateBackup('texto')).toThrow();
  });
  it('rejeita versão de esquema desconhecida', () => {
    expect(() => validateBackup({ ...valid(), schemaVersion: 3 })).toThrow('incompatível');
    expect(() => validateBackup({ ...valid(), schemaVersion: 0 })).toThrow('incompatível');
  });
  it('rejeita ingrediente com unidade ou quantidade inválida', () => {
    const a = valid(); a.ingredients[0].unit = 'xx';
    const b = valid(); b.ingredients[0].purchaseQuantity = 0;
    expect(() => validateBackup(a)).toThrow('Ingrediente');
    expect(() => validateBackup(b)).toThrow('Ingrediente');
  });
  it('rejeita receita com rendimento zero ou margem de 100%', () => {
    const a = valid(); a.recipes[0].yield = 0;
    const b = valid(); b.recipes[0].desiredMargin = 100;
    expect(() => validateBackup(a)).toThrow('Receita');
    expect(() => validateBackup(b)).toThrow('Receita');
  });
  it('rejeita encomenda com status inválido ou quantidade negativa', () => {
    const a = valid(); a.orders[0].status = 'Cancelado';
    const b = valid(); b.orders[0].quantity = -1;
    expect(() => validateBackup(a)).toThrow('Encomenda');
    expect(() => validateBackup(b)).toThrow('Encomenda');
  });
  it('aceita unidade culinária, densidade, equivalência por unidade e xícara configurada; rejeita valores inválidos', () => {
    const ok = valid(); Object.assign(ok.ingredients[0], { densityGPerMl: 0.5, gramsPerUnit: 50 }); Object.assign(ok.recipes[0].items[0], { unit: 'xic' }); Object.assign(ok, { settings: { cupSizeMl: 250 } });
    expect(() => validateBackup(ok)).not.toThrow();
    const badDensity = valid(); Object.assign(badDensity.ingredients[0], { densityGPerMl: 0 });
    const badUnit = valid(); Object.assign(badUnit.recipes[0].items[0], { unit: 'balde' });
    const badCup = valid(); Object.assign(badCup, { settings: { cupSizeMl: -1 } });
    expect(() => validateBackup(badDensity)).toThrow('Ingrediente');
    expect(() => validateBackup(badUnit)).toThrow('Receita');
    expect(() => validateBackup(badCup)).toThrow('Configurações');
  });
  it('migra backups antigos com gramsPerCup para densidade em g/mL', () => {
    const old = valid(); Object.assign(old.ingredients[0], { gramsPerCup: 120 });
    const migrated = validateBackup(old).ingredients[0] as unknown as Record<string, unknown>;
    expect(migrated.densityGPerMl).toBe(0.5);
    expect('gramsPerCup' in migrated).toBe(false);
  });
});
