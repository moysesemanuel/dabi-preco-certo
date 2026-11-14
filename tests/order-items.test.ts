/**
 * Etapa 11 — encomendas com várias receitas e confirmação automática por pagamento (regras de domínio, sem rede).
 */
import { describe, expect, it } from 'vitest';
import { LEGACY_ITEM_ID, migrateStored, upgradeOrderShape, validateDataSet } from '../shared/dataset';
import { computeTotals, validatePublicQuote } from '../shared/publicQuote';
import { captureCostSnapshot, financialItems, orderCostBasis, orderTotalCost } from '../src/domain/orderCost';
import { calculateOrderFinancials, itemSubtotal } from '../src/domain/orderFinancials';
import { createOrder, itemsSummary, orderProductText, updateOrder, validateItemDrafts, type OrderItemDraft } from '../src/domain/orders';
import { statusAfterReceipt } from '../src/domain/orderStatus';
import { addPayment, balanceDue, orderTotal, removePayment, totalReceived } from '../src/domain/payments';
import { filterOrders } from '../src/domain/orderSearch';
import type { DataSet, Order, OrderStatus } from '../src/domain/types';
import { buildPublicQuote, buildQuoteText, BUNDLED_LINE } from '../src/features/sharing/quotes';
import { reconcileFinancial } from '../src/sync/reconcile';
import { resolveConflict } from '../src/sync/resolve';
import { emptyMeta, type ConflictRecord } from '../src/sync/engine';
import { renderQuotePage } from '../worker/src/render';
import { asOrder } from './helpers/orders';

const NOW = new Date('2026-11-14T12:00:00.000Z');
/**
 * Catálogo da confeitaria do exemplo obrigatório. Custos (por unidade):
 *  - Brigadeiro: ingredientes 0,60 + forminha 0,05 + plástico 0,10 = 0,75
 *  - Beijinho:   ingredientes 0,50 + forminha 0,05            = 0,55
 *  - Bolo:       ingredientes 20,00 + base 3,00                = 23,00
 */
const catalog = (): DataSet => ({
  schemaVersion: 5,
  ingredients: [{ id: 'chocolate', name: 'Mistura brigadeiro', unit: 'un', purchaseQuantity: 100, purchasePrice: 60 },
    { id: 'coco', name: 'Mistura beijinho', unit: 'un', purchaseQuantity: 100, purchasePrice: 50 },
    { id: 'massa', name: 'Massa de bolo', unit: 'un', purchaseQuantity: 1, purchasePrice: 20 }],
  packagings: [{ id: 'forminha', name: 'Forminha', purchasePrice: 5, purchaseQuantity: 100, active: true },
    { id: 'plastico', name: 'Plástico', purchasePrice: 10, purchaseQuantity: 100, active: true },
    { id: 'base', name: 'Base de bolo', purchasePrice: 3, purchaseQuantity: 1, active: true },
    { id: 'caixa', name: 'Caixa para doces', purchasePrice: 10, purchaseQuantity: 1, capacity: 50, active: true },
    { id: 'sacola', name: 'Sacola', purchasePrice: 2, purchaseQuantity: 1, active: true }],
  recipes: [
    { id: 'brig', name: 'Brigadeiro Gourmet', yield: 1, items: [{ ingredientId: 'chocolate', quantity: 1 }], packagingItems: [{ packagingId: 'forminha', quantityPerUnit: 1 }, { packagingId: 'plastico', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 },
    { id: 'beij', name: 'Beijinho', yield: 1, items: [{ ingredientId: 'coco', quantity: 1 }], packagingItems: [{ packagingId: 'forminha', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 },
    { id: 'bolo', name: 'Bolo de cenoura', yield: 1, items: [{ ingredientId: 'massa', quantity: 1 }], packagingItems: [{ packagingId: 'base', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 },
  ],
  orders: [],
  settings: { cupSizeMl: 240, businessName: 'Doces da Bia' },
});
const EXAMPLE: OrderItemDraft[] = [{ recipeId: 'brig', quantity: 50, unitPrice: 2.5 }, { recipeId: 'beij', quantity: 30, unitPrice: 2.5 }, { recipeId: 'bolo', quantity: 1, unitPrice: 65 }];
// Embalagens adicionais da encomenda: 1 caixa (10,00) + 1 sacola (2,00) = 12,00
const EXTRA = [{ packagingId: 'caixa', name: 'Caixa para doces', quantity: 1, unitCost: 10 }, { packagingId: 'sacola', name: 'Sacola', quantity: 1, unitCost: 2 }];
let seq = 0;
const ids = () => ({ newItemId: () => `it${++seq}` });
const create = (d: DataSet, over: Partial<Parameters<typeof createOrder>[1]> = {}) =>
  createOrder(d, { customer: 'Ana', items: EXAMPLE, deliveryDate: '2026-12-20', deposit: 0, packagingItems: EXTRA, ...over }, { id: 'o1', quoteCode: 'ORC-K7M42P', now: NOW, ...ids() });
const withOrder = (d: DataSet, o: Order): DataSet => ({ ...d, orders: [o] });

describe('Cálculo financeiro com vários itens', () => {
  it('exemplo obrigatório: 125 + 75 + 65 = 265 em produtos, + 12 de embalagens = 277 cobrados', () => {
    const order = create(catalog());
    expect(order.items.map(i => itemSubtotal(i))).toEqual([125, 75, 65]);
    const f = calculateOrderFinancials({ items: order.items, packagingCharge: order.packagingCharge });
    expect(f).toMatchObject({ productsTotal: 265, packagingCharge: 12, totalCharged: 277, balanceDue: 277 });
    expect(orderTotal(order)).toBe(277);
  });
  it('cada item usa o SEU preço (nunca o da primeira receita) e as embalagens gerais não multiplicam pelos produtos', () => {
    const order = create(catalog(), { items: [{ recipeId: 'brig', quantity: 10, unitPrice: 3 }, { recipeId: 'bolo', quantity: 2, unitPrice: 80 }] });
    expect(orderTotal(order)).toBe(10 * 3 + 2 * 80 + 12);
  });
  it('custo: cada item com as embalagens da SUA receita, somadas uma vez; adicionais entram no custo; lucro = cobrado − custo', () => {
    const d = catalog(); const order = create(d);
    expect(order.items.map(i => i.costSnapshot?.costPerUnit)).toEqual([0.75, 0.55, 23]);
    expect(order.items[0].costSnapshot?.packagingItems?.map(p => p.packagingId)).toEqual(['forminha', 'plastico']);
    expect(order.items[1].costSnapshot?.packagingItems?.map(p => p.packagingId)).toEqual(['forminha']); // o plástico do brigadeiro não vaza para o beijinho
    expect(order.items[2].costSnapshot?.packagingItems?.map(p => p.packagingId)).toEqual(['base']);
    const cost = 50 * 0.75 + 30 * 0.55 + 23 + 12; // 37,50 + 16,50 + 23 + 12 = 89
    expect(orderTotalCost(order, d)).toBeCloseTo(cost, 10);
    const f = calculateOrderFinancials({ items: financialItems(order, d), packagingCharge: order.packagingCharge, additionalPackagingCost: 12 });
    expect(f).toMatchObject({ estimatedCost: 89, estimatedProfit: 188 });
  });
  it('um item sem custo calculável torna o custo da encomenda indisponível (nunca zero)', () => {
    const d = catalog(); const order = create(d);
    const broken = { ...withOrder(d, { ...order, items: [order.items[0], { ...order.items[1], costSnapshot: undefined, recipeId: 'sumiu' }] }) };
    expect(orderCostBasis(broken.orders[0], broken)).toBe('unavailable');
    expect(orderTotalCost(broken.orders[0], broken)).toBeUndefined();
    expect(calculateOrderFinancials({ items: financialItems(broken.orders[0], broken) }).estimatedCost).toBeUndefined();
  });
  it('preços fracionários e arredondamento: cada subtotal em centavos exatos, sem ruído binário', () => {
    expect(itemSubtotal({ quantity: 3, unitPrice: 0.1 })).toBe(0.3);
    expect(itemSubtotal({ quantity: 7, unitPrice: 1.15 })).toBe(8.05);
    expect(calculateOrderFinancials({ items: [{ quantity: 3, unitPrice: 0.1 }, { quantity: 7, unitPrice: 1.15 }, { quantity: 1, unitPrice: 0.01 }], packagingCharge: 0.07 }))
      .toMatchObject({ productsTotal: 8.36, totalCharged: 8.43 });
  });
  it('sinal e saldo sobre o total com embalagens', () => {
    const order = create(catalog(), { deposit: 77 });
    expect(totalReceived(order)).toBe(77); expect(balanceDue(order)).toBe(200);
    expect(() => create(catalog(), { deposit: 277.01 })).toThrow(/sinal/);
  });
});

describe('Itens: cadastro e edição', () => {
  it('exige pelo menos um item válido, receita existente, quantidade e preço', () => {
    const d = catalog();
    expect(() => validateItemDrafts(d, [])).toThrow(/pelo menos um produto/);
    expect(() => validateItemDrafts(d, [{ recipeId: '', quantity: 1, unitPrice: 1 }])).toThrow(/Receita do produto 1/);
    expect(() => validateItemDrafts(d, [{ recipeId: 'brig', quantity: 0, unitPrice: 1 }])).toThrow(/quantidade/);
    expect(() => validateItemDrafts(d, [{ recipeId: 'brig', quantity: 1, unitPrice: Number.NaN }])).toThrow(/preço/);
  });
  it('a mesma receita em dois itens é recusada (regra: some as quantidades em um único item)', () => {
    expect(() => validateItemDrafts(catalog(), [{ recipeId: 'brig', quantity: 1, unitPrice: 1 }, { recipeId: 'brig', quantity: 2, unitPrice: 1 }])).toThrow(/mais de um item/);
  });
  it('cada item guarda id próprio, nome da receita e custo congelados no momento do cadastro', () => {
    const order = create(catalog());
    expect(new Set(order.items.map(i => i.id)).size).toBe(3);
    expect(order.items.map(i => i.recipeName)).toEqual(['Brigadeiro Gourmet', 'Beijinho', 'Bolo de cenoura']);
    expect(order.items.every(i => i.costSnapshot?.capturedAt === NOW.toISOString())).toBe(true);
  });
  it('mudanças posteriores (preço de ingrediente, receita renomeada, embalagem desativada) não alteram os valores históricos', () => {
    const d = catalog(); const order = create(d);
    const later: DataSet = { ...withOrder(d, order), ingredients: d.ingredients.map(i => ({ ...i, purchasePrice: i.purchasePrice * 3 })),
      recipes: d.recipes.map(r => ({ ...r, name: `${r.name} (novo)` })), packagings: d.packagings.map(p => ({ ...p, active: false, purchasePrice: 99 })) };
    expect(orderTotalCost(later.orders[0], later)).toBeCloseTo(89, 10);
    expect(itemsSummary(later.orders[0], later.recipes)).toBe('3 itens — Brigadeiro Gourmet, Beijinho e Bolo de cenoura');
    expect(orderTotal(later.orders[0])).toBe(277);
  });
  it('edição: item mantido conserva custo e nome; quantidade e preço mudam só por escolha; item novo recebe o custo atual; item removido some', () => {
    const d = catalog(); const order = create(d);
    const pricier: DataSet = { ...withOrder(d, order), ingredients: d.ingredients.map(i => (i.id === 'chocolate' ? { ...i, purchasePrice: 120 } : i)), recipes: d.recipes.map(r => (r.id === 'brig' ? { ...r, name: 'Brigadeiro (renomeado)' } : r)) };
    const [brig, , bolo] = order.items;
    const next = updateOrder(pricier, 'o1', { customer: 'Ana', deliveryDate: '2026-12-20', deposit: 0, packagingItems: EXTRA, items: [
      { id: brig.id, recipeId: 'brig', quantity: 60, unitPrice: 2.4 }, // mantido, com nova quantidade e preço
      { id: bolo.id, recipeId: 'bolo', quantity: 1, unitPrice: 65 },   // mantido sem mudanças
      { recipeId: 'beij', quantity: 10, unitPrice: 2.5 },             // reincluído como item NOVO (o antigo foi removido)
    ] }, NOW, ids());
    const items = next.orders[0].items;
    expect(items[0]).toMatchObject({ id: brig.id, recipeName: 'Brigadeiro Gourmet', quantity: 60, unitPrice: 2.4, costSnapshot: brig.costSnapshot });
    expect(items[1]).toEqual(bolo);
    expect(items[2].id).not.toBe(order.items[1].id);
    expect(items).toHaveLength(3);
    expect(orderTotal(next.orders[0])).toBe(60 * 2.4 + 65 + 10 * 2.5 + 12);
  });
  it('trocar a receita de uma linha registra o custo da nova receita (nunca mantém o custo de outro produto)', () => {
    const d = catalog(); const order = create(d, { items: [{ recipeId: 'brig', quantity: 10, unitPrice: 2 }] });
    const next = updateOrder(withOrder(d, order), 'o1', { customer: 'Ana', deliveryDate: '2026-12-20', deposit: 0, items: [{ id: order.items[0].id, recipeId: 'beij', quantity: 10, unitPrice: 2 }] }, NOW, ids());
    expect(next.orders[0].items[0]).toMatchObject({ recipeId: 'beij', recipeName: 'Beijinho', costSnapshot: { costPerUnit: 0.55 } });
  });
  it('edição depois de recebimento: recebimentos preservados, sem duplicar; o total não pode ficar abaixo do recebido', () => {
    const d = catalog(); const created = create(d, { deposit: 50 });
    const paid = addPayment(withOrder(d, created), 'o1', { id: 'p1', amount: 100, receivedAt: '2026-11-15' });
    const items = paid.orders[0].items.map(i => ({ id: i.id, recipeId: i.recipeId, quantity: i.quantity, unitPrice: i.unitPrice }));
    const edited = updateOrder(paid, 'o1', { customer: 'Ana Paula', deliveryDate: '2026-12-20', deposit: 50, packagingItems: EXTRA, items: items.slice(0, 2) }, NOW);
    expect(edited.orders[0].payments).toEqual([{ id: 'p1', amount: 100, receivedAt: '2026-11-15' }]);
    expect(orderTotal(edited.orders[0])).toBe(212);
    expect(() => updateOrder(paid, 'o1', { customer: 'Ana', deliveryDate: '2026-12-20', deposit: 50, packagingItems: EXTRA, items: [{ ...items[2], quantity: 1 }] }, NOW)).toThrow(/abaixo do que já foi recebido/);
  });
  it('resumo e busca: a lista mostra os itens e a busca encontra o pedido por QUALQUER receita', () => {
    const d = catalog(); const order = create(d);
    expect(itemsSummary(order, d.recipes)).toBe('3 itens — Brigadeiro Gourmet, Beijinho e Bolo de cenoura');
    expect(itemsSummary({ items: [order.items[0]] }, d.recipes)).toBe('Brigadeiro Gourmet · 50 un.');
    const many = { items: [...order.items, ...['a', 'b'].map((x, k) => ({ ...order.items[0], id: x, recipeName: `Extra ${k + 1}` }))] };
    expect(itemsSummary(many, d.recipes)).toBe('5 itens — Brigadeiro Gourmet, Beijinho, Bolo de cenoura e mais 2');
    const ctx = { codes: new Map([['o1', 'ORC-K7M42P']]), productOf: (o: Order) => orderProductText(o, d.recipes) };
    expect(filterOrders([order], 'cenoura', ctx)).toHaveLength(1);
    expect(filterOrders([order], 'beijinho ana', ctx)).toHaveLength(1);
    expect(filterOrders([order], 'pudim', ctx)).toHaveLength(0);
  });
});

describe('Confirmação automática por pagamento', () => {
  const at = (status: OrderStatus, deposit = 0) => { const d = catalog(); return withOrder(d, { ...create(d, { deposit }), status }); };
  const pay = (id: string, amount: number) => ({ id, amount, receivedAt: '2026-11-15' });
  it('criar orçamento sem sinal: permanece Orçamento; com sinal zero também', () => {
    expect(create(catalog()).status).toBe('Orçamento');
    expect(create(catalog(), { deposit: 0 }).status).toBe('Orçamento');
  });
  it('criar orçamento com sinal recebido: nasce Confirmado (sinal e status no mesmo registro)', () => {
    const order = create(catalog(), { deposit: 50 });
    expect(order).toMatchObject({ status: 'Confirmado', deposit: 50 });
  });
  it('pagamento parcial ou integral em orçamento confirma; pagamento repetido (mesmo id) é recusado e não duplica', () => {
    const partial = addPayment(at('Orçamento'), 'o1', pay('p1', 10));
    expect(partial.orders[0]).toMatchObject({ status: 'Confirmado', payments: [pay('p1', 10)] });
    const full = addPayment(at('Orçamento'), 'o1', pay('p1', 277));
    expect(full.orders[0]).toMatchObject({ status: 'Confirmado' }); expect(balanceDue(full.orders[0])).toBe(0);
    expect(() => addPayment(partial, 'o1', pay('p1', 10))).toThrow(/duplicado/);
    expect(partial.orders[0].payments).toHaveLength(1);
  });
  it('pagamento zero, inválido ou acima do saldo NÃO confirma e não altera nada (falha não confirma)', () => {
    const d = at('Orçamento');
    for (const amount of [0, -5, Number.NaN, 277.01]) expect(() => addPayment(d, 'o1', pay('p', amount))).toThrow();
    expect(d.orders[0].status).toBe('Orçamento'); expect(d.orders[0].payments).toBeUndefined();
  });
  it('confirmado, em produção e entregue não mudam ao receber (nada avança nem regride automaticamente)', () => {
    for (const status of ['Confirmado', 'Produção', 'Entregue'] as const) expect(addPayment(at(status), 'o1', pay('p1', 10)).orders[0].status).toBe(status);
    expect(statusAfterReceipt('Confirmado', 100)).toBe('Confirmado');
  });
  it('confirmar manualmente sem pagamento continua possível (a regra só acrescenta, não exige)', () => {
    expect(create(catalog(), { status: 'Confirmado' }).status).toBe('Confirmado');
  });
  it('remover ou corrigir um recebimento NÃO devolve o pedido a Orçamento', () => {
    const paid = addPayment(at('Orçamento'), 'o1', pay('p1', 10));
    const removed = removePayment(paid, 'o1', 'p1');
    expect(removed.orders[0]).toMatchObject({ status: 'Confirmado' }); expect(removed.orders[0].payments).toBeUndefined();
    const items = paid.orders[0].items.map(i => ({ id: i.id, recipeId: i.recipeId, quantity: i.quantity, unitPrice: i.unitPrice }));
    const depositLowered = updateOrder(withOrder(catalog(), { ...create(catalog(), { deposit: 50 }) }), 'o1', { customer: 'Ana', deliveryDate: '2026-12-20', deposit: 0, packagingItems: EXTRA, items }, NOW);
    expect(depositLowered.orders[0].status).toBe('Confirmado');
  });
  it('editar: aumentar o sinal de um orçamento confirma; editar sem mudar o sinal preserva Orçamento', () => {
    const d = at('Orçamento');
    const items = d.orders[0].items.map(i => ({ id: i.id, recipeId: i.recipeId, quantity: i.quantity, unitPrice: i.unitPrice }));
    const patch = { customer: 'Ana', deliveryDate: '2026-12-20', packagingItems: EXTRA, items };
    expect(updateOrder(d, 'o1', { ...patch, deposit: 0 }, NOW).orders[0].status).toBe('Orçamento');
    expect(updateOrder(d, 'o1', { ...patch, deposit: 30 }, NOW).orders[0].status).toBe('Confirmado');
    expect(updateOrder(at('Produção'), 'o1', { ...patch, deposit: 30 }, NOW).orders[0].status).toBe('Produção');
  });
  it('reconciliação "somar" de um recebimento perdido confirma o orçamento do servidor; "manter minha versão" não regride status', () => {
    const d = at('Orçamento');
    const conflict: ConflictRecord = { id: 'c', kind: 'orders', entityId: 'o1', at: NOW.toISOString(), reason: 'edited-elsewhere', local: null, server: d.orders[0], financial: { addedPayments: [pay('lost', 20)], removedPayments: [] } };
    expect(reconcileFinancial(d, conflict, 'merge', NOW).data.orders[0]).toMatchObject({ status: 'Confirmado', payments: [pay('lost', 20)] });
    // Nuvem confirmada por um recebimento; aqui o orçamento só mudou o nome do cliente. Manter a versão local leva o recebimento e o status confirmado.
    const server = addPayment(d, 'o1', pay('srv', 15)).orders[0];
    const local = { ...d.orders[0], customer: 'Ana Paula' };
    const meta = { ...emptyMeta(), baseline: d, conflicts: [{ id: 'k', kind: 'orders' as const, entityId: 'o1', at: NOW.toISOString(), reason: 'edited-elsewhere' as const, local, server, base: d.orders[0], serverRev: 3, pending: true }] };
    const kept = resolveConflict(withOrder(catalog(), local), meta, 'k', 'keep-local', NOW).data.orders[0];
    expect(kept).toMatchObject({ customer: 'Ana Paula', status: 'Confirmado', payments: [pay('srv', 15)] });
  });
});

describe('Compatibilidade com encomendas antigas (uma receita)', () => {
  const legacy = { id: 'old', customer: 'Bia', recipeId: 'bolo', quantity: 2, unitPrice: 50, deposit: 10, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-01T10:00:00.000Z', costSnapshot: { costPerUnit: 21, capturedAt: '2026-11-01T10:00:00.000Z' }, payments: [{ id: 'p', amount: 5, receivedAt: '2026-11-02' }], quoteCode: 'ORC-ABCDEF' };
  it('vira UM item com id fixo, o mesmo custo histórico, sem nome inventado; status, sinal, código e recebimentos intactos', () => {
    const order = asOrder(legacy);
    expect(order.items).toEqual([{ id: LEGACY_ITEM_ID, recipeId: 'bolo', quantity: 2, unitPrice: 50, costSnapshot: legacy.costSnapshot }]);
    expect(order).toMatchObject({ status: 'Orçamento', deposit: 10, quoteCode: 'ORC-ABCDEF', payments: legacy.payments });
    expect(Object.keys(order)).not.toEqual(expect.arrayContaining(['recipeId', 'quantity', 'unitPrice', 'costSnapshot']));
    expect(orderTotal(order)).toBe(100);
  });
  it('a conversão é determinística e idempotente (dois aparelhos chegam ao mesmo resultado, sem conflito)', () => {
    expect(upgradeOrderShape(legacy)).toEqual(upgradeOrderShape(legacy));
    expect(upgradeOrderShape(upgradeOrderShape(legacy))).toEqual(upgradeOrderShape(legacy));
  });
  it('carregar dados antigos NÃO confirma retroativamente um orçamento que já tinha sinal', () => {
    const d = migrateStored({ schemaVersion: 4, ingredients: [], recipes: catalog().recipes, orders: [legacy], packagings: [] });
    expect(d.orders[0].status).toBe('Orçamento');
    expect(validateDataSet({ ...catalog(), schemaVersion: 4, orders: [legacy] }).orders[0].status).toBe('Orçamento');
  });
  it('backup v4 importa como v5; exportação v5 reimporta idêntica; itens inválidos são recusados', () => {
    const v5 = validateDataSet({ ...catalog(), schemaVersion: 4, orders: [legacy] });
    expect(v5.schemaVersion).toBe(5);
    const order = create(catalog(), { deposit: 20 });
    const exported = JSON.parse(JSON.stringify({ ...catalog(), orders: [order] }));
    expect(validateDataSet(exported).orders[0]).toEqual(order);
    const bad = (items: unknown) => () => validateDataSet({ ...catalog(), orders: [{ ...order, items }] });
    expect(bad([])).toThrow(/pelo menos um produto/);
    expect(bad([order.items[0], order.items[0]])).toThrow(/repetido/);
    expect(bad([{ ...order.items[0], recipeId: 'sumiu' }])).toThrow(/inexistente/);
    expect(bad(Array.from({ length: 51 }, (_, k) => ({ ...order.items[0], id: `i${k}` })))).toThrow(/demais/);
  });
  it('editar uma encomenda antiga preserva o item legado (id, custo) e não inventa nome histórico', () => {
    const d = { ...catalog(), orders: [asOrder(legacy)] };
    const next = updateOrder(d, 'old', { customer: 'Bia', deliveryDate: '2026-12-01', deposit: 10, items: [{ id: LEGACY_ITEM_ID, recipeId: 'bolo', quantity: 3, unitPrice: 50 }] }, NOW);
    expect(next.orders[0].items[0]).toEqual({ id: LEGACY_ITEM_ID, recipeId: 'bolo', quantity: 3, unitPrice: 50, costSnapshot: legacy.costSnapshot });
    expect(next.orders[0].status).toBe('Orçamento'); // sinal não aumentou: nada a confirmar
  });
});

describe('Apresentação pública: nunca expõe custos nem embalagens', () => {
  const opts = { issuedAt: '2026-11-14' };
  const FORBIDDEN = ['Caixa', 'Sacola', 'Forminha', 'Plástico', 'Base de bolo', 'unitCost', 'packaging', 'costPerUnit', 'costSnapshot', '12,00', '1200', 'Ana', 'margin', 'deposit'];
  it('com embalagens adicionais: lista os produtos sem preço e mostra só o total consolidado (277,00)', () => {
    const d = catalog(); const order = create(d);
    const r = buildPublicQuote(order, d.recipes, d.settings, opts); if (!r.ok) throw new Error(r.error);
    expect(r.quote.includedItems).toEqual([{ description: 'Brigadeiro Gourmet', quantity: 50 }, { description: 'Beijinho', quantity: 30 }, { description: 'Bolo de cenoura', quantity: 1 }]);
    expect(r.quote.items).toEqual([{ description: BUNDLED_LINE, quantity: 1, unitPriceCents: 27_700 }]);
    expect(computeTotals(r.quote).totalCents).toBe(27_700);
    const json = JSON.stringify(r.quote); for (const s of FORBIDDEN) expect(json, s).not.toContain(s);
    const page = renderQuotePage(r.quote, { expired: false });
    for (const s of ['50 × Brigadeiro Gourmet', '30 × Beijinho', 'Bolo de cenoura', 'R$ 277,00']) expect(page, s).toContain(s);
    for (const s of ['Caixa', 'Sacola', 'Forminha', 'R$ 12,00', 'R$ 265,00', 'R$ 2,50']) expect(page, s).not.toContain(s);
    const text = buildQuoteText(order, d.recipes, 'ORC-K7M42P');
    expect(text).toContain('• 50 × Brigadeiro Gourmet'); expect(text).toMatch(/Total: R\$\s*277,00/);
    for (const s of ['Caixa', 'Sacola', 'Embalage', '12,00', '265,00', '2,50']) expect(text, s).not.toContain(s);
  });
  it('sem embalagens adicionais: cada produto com preço e subtotal; a soma visível é exatamente o total', () => {
    const d = catalog(); const order = create(d, { packagingItems: [] });
    const r = buildPublicQuote(order, d.recipes, d.settings, { ...opts, deliveryFee: 10, discount: 5 }); if (!r.ok) throw new Error(r.error);
    expect(r.quote.includedItems).toBeUndefined();
    expect(r.quote.items).toEqual([{ description: 'Brigadeiro Gourmet', quantity: 50, unitPriceCents: 250 }, { description: 'Beijinho', quantity: 30, unitPriceCents: 250 }, { description: 'Bolo de cenoura', quantity: 1, unitPriceCents: 6500 }]);
    const t = computeTotals(r.quote);
    expect(t.lines.map(l => l.lineTotalCents)).toEqual([12_500, 7_500, 6_500]);
    expect(t).toMatchObject({ subtotalCents: 26_500, deliveryFeeCents: 1000, discountCents: 500, totalCents: 27_000 }); // entrega e desconto preservados
    expect(buildQuoteText(order, d.recipes, 'ORC-K7M42P')).toContain('• 50 × Brigadeiro Gourmet (R$ 2,50 cada): R$ 125,00');
  });
  it('o contrato público valida produtos inclusos: campos extras e listas inválidas são recusados', () => {
    const d = catalog(); const r = buildPublicQuote(create(d), d.recipes, d.settings, opts); if (!r.ok) throw new Error(r.error);
    expect(validatePublicQuote(r.quote).ok).toBe(true);
    expect(validatePublicQuote({ ...r.quote, includedItems: [{ description: 'X', quantity: 1, unitCost: 3 }] })).toMatchObject({ ok: false, error: 'UNKNOWN_FIELD' });
    expect(validatePublicQuote({ ...r.quote, includedItems: [] })).toMatchObject({ ok: false, error: 'EMPTY_ITEMS' });
    expect(validatePublicQuote({ ...r.quote, includedItems: [{ description: 'X', quantity: 0 }] })).toMatchObject({ ok: false, error: 'INVALID_QUANTITY' });
  });
  it('encomenda antiga (item sem nome registrado) usa o nome atual da receita no orçamento', () => {
    const d = catalog(); const old = asOrder({ id: 'old', customer: 'Bia', recipeId: 'bolo', quantity: 2, unitPrice: 50, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-01T10:00:00.000Z' });
    const r = buildPublicQuote(old, d.recipes, d.settings, opts); if (!r.ok) throw new Error(r.error);
    expect(r.quote.items).toEqual([{ description: 'Bolo de cenoura', quantity: 2, unitPriceCents: 5000 }]);
    expect(buildPublicQuote(old, [], d.settings, opts)).toMatchObject({ ok: false, error: expect.stringContaining('receita') });
  });
});

it('captureCostSnapshot continua por receita (base do custo de cada item)', () => {
  const d = catalog(); expect(captureCostSnapshot(d.recipes[1], d, NOW)?.costPerUnit).toBe(0.55);
});

it('metadados de sincronização antigos (base e conflitos) são convertidos com a mesma regra, para a comparação continuar exata', async () => {
  const { migrateMeta } = await import('../src/storage/db');
  const legacy = { id: 'old', customer: 'Bia', recipeId: 'bolo', quantity: 2, unitPrice: 50, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-01T10:00:00.000Z' };
  const meta = { ...emptyMeta(), baseline: { ...emptyMeta().baseline, schemaVersion: 4, orders: [legacy] } as unknown as DataSet,
    conflicts: [{ id: 'c', kind: 'orders' as const, entityId: 'old', at: NOW.toISOString(), reason: 'edited-elsewhere' as const, local: legacy, server: null, base: legacy, pending: true }] };
  const out = migrateMeta(meta);
  expect(out.baseline.orders[0]).toEqual(asOrder(legacy));
  expect(out.conflicts[0]).toMatchObject({ local: asOrder(legacy), server: null, base: asOrder(legacy) });
});
