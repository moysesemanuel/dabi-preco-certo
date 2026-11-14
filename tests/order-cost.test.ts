import { asOrder, updateLegacyOrder } from './helpers/orders';
import { describe, expect, it } from 'vitest';

import { captureCostSnapshot, itemUnitCost } from '../src/domain/orderCost';
const orderUnitCost = (o: Order, d: DataSet) => itemUnitCost(o.items[0], d);
import type { DataSet, Order } from '../src/domain/types';

const NOW = new Date('2026-11-12T10:00:00Z');
const data = (): DataSet => ({
  schemaVersion: 2,
  ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1000, unit: 'g', purchasePrice: 6 }],
  recipes: [
    { id: 'r1', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }, // custo/un = 4
    { id: 'r2', name: 'Pão', yield: 10, items: [{ ingredientId: 'f', quantity: 1000 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 20 }, // custo/un = 0,6
  ],
  orders: [],
});
const order = (over: Partial<Order> = {}): Order => asOrder({ id: 'o', customer: 'Ana', recipeId: 'r1', quantity: 2, unitPrice: 5, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });

describe('Custo histórico da encomenda', () => {
  it('captura o custo unitário atual da receita', () => {
    expect(captureCostSnapshot(data().recipes[0], data(), NOW)).toEqual({ costPerUnit: 4, capturedAt: NOW.toISOString() });
  });
  it('o custo registrado NÃO muda quando o preço do ingrediente sobe', () => {
    const d = data();
    const snap = captureCostSnapshot(d.recipes[0], d, NOW)!;
    const o = order({ costSnapshot: snap });
    const inflated: DataSet = { ...d, ingredients: [{ ...d.ingredients[0], purchasePrice: 60 }], orders: [o] };
    expect(orderUnitCost(o, inflated)).toEqual({ basis: 'recorded', costPerUnit: 4 });
  });
  it('o custo registrado NÃO muda quando a receita é alterada', () => {
    const d = data();
    const o = order({ costSnapshot: captureCostSnapshot(d.recipes[0], d, NOW)! });
    const changed: DataSet = { ...d, recipes: [{ ...d.recipes[0], laborTotal: 500, yield: 2 }, d.recipes[1]], orders: [o] };
    expect(orderUnitCost(o, changed).basis).toBe('recorded');
    expect((orderUnitCost(o, changed) as { costPerUnit: number }).costPerUnit).toBe(4);
  });
  it('encomenda antiga sem snapshot é ESTIMADA (não registrada) com o custo atual', () => {
    const d = { ...data(), orders: [order()] };
    expect(orderUnitCost(d.orders[0], d)).toEqual({ basis: 'estimated', costPerUnit: 4 });
    const pricier: DataSet = { ...d, ingredients: [{ ...d.ingredients[0], purchasePrice: 60 }] };
    // farinha a R$ 60/kg: 500 g = 30 + embalagem 10 + mão de obra 20 + extras 7 = 67 → R$ 6,70 por unidade
    expect(orderUnitCost(pricier.orders[0], pricier)).toEqual({ basis: 'estimated', costPerUnit: 6.7 });
    expect(orderUnitCost(pricier.orders[0], pricier).basis).toBe('estimated'); // nunca "recorded"
  });
  it('custo não calculável → indisponível, nunca zero', () => {
    const d = data();
    const broken: DataSet = { ...d, recipes: [{ ...d.recipes[0], items: [{ ingredientId: 'f', quantity: 2, unit: 'xic' }] }], orders: [order()] };
    expect(orderUnitCost(broken.orders[0], broken)).toEqual({ basis: 'unavailable' });
    expect(captureCostSnapshot(broken.recipes[0], broken, NOW)).toBeUndefined();
    expect(orderUnitCost(order({ recipeId: 'sumiu' }), d)).toEqual({ basis: 'unavailable' });
  });
  it('editar a encomenda (sem trocar a receita) preserva o snapshot, mesmo com preços novos', () => {
    const d = data();
    const snap = { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' };
    const withOrder: DataSet = { ...d, ingredients: [{ ...d.ingredients[0], purchasePrice: 60 }], orders: [order({ costSnapshot: snap })] };
    const next = updateLegacyOrder(withOrder, 'o', { customer: 'Ana M.', recipeId: 'r1', quantity: 5, unitPrice: 9, deliveryDate: '2026-12-02', deposit: 1 }, NOW);
    expect(next.orders[0].items[0].costSnapshot).toEqual(snap);
    expect(next.orders[0]).toMatchObject({ customer: 'Ana M.', items: [{ quantity: 5, unitPrice: 9 }] });
  });
  it('editar uma encomenda ANTIGA não cria snapshot (não inventa histórico)', () => {
    const d = { ...data(), orders: [order()] };
    const next = updateLegacyOrder(d, 'o', { customer: 'Ana', recipeId: 'r1', quantity: 3, unitPrice: 5, deliveryDate: '2026-12-01', deposit: 0 }, NOW);
    expect(next.orders[0].items[0].costSnapshot).toBeUndefined();
  });
  it('trocar a receita da encomenda registra o custo da nova receita, na data da troca', () => {
    const d = { ...data(), orders: [order({ costSnapshot: { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' } })] };
    const next = updateLegacyOrder(d, 'o', { customer: 'Ana', recipeId: 'r2', quantity: 2, unitPrice: 5, deliveryDate: '2026-12-01', deposit: 0 }, NOW);
    expect(next.orders[0].items[0].costSnapshot).toEqual({ costPerUnit: 0.6, capturedAt: NOW.toISOString() });
  });
  it('trocar para uma receita sem custo calculável remove o snapshot antigo (nunca mantém o custo de outro produto)', () => {
    const d = data();
    const broken = { ...d, recipes: [d.recipes[0], { ...d.recipes[1], items: [{ ingredientId: 'f', quantity: 1, unit: 'xic' as const }] }], orders: [order({ costSnapshot: { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' } })] };
    const next = updateLegacyOrder(broken, 'o', { customer: 'Ana', recipeId: 'r2', quantity: 2, unitPrice: 5, deliveryDate: '2026-12-01', deposit: 0 }, NOW);
    expect(next.orders[0].items[0].costSnapshot).toBeUndefined();
  });
});
