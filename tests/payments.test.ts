import { beforeEach, describe, expect, it } from 'vitest';
import { validateDataSet } from '../shared/dataset';
import { emptyPush } from '../shared/sync';
import { updateOrder } from '../src/domain/edit';
import { addPayment, balanceDue, orderTotal, removePayment, totalReceived } from '../src/domain/payments';
import { calculateOrderFinancials } from '../src/domain/orderFinancials';
import type { DataSet, Order, Payment } from '../src/domain/types';
import { emptyDataSet } from '../src/sync/engine';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

const order = (over: Partial<Order> = {}): Order => ({ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 50, deposit: 20, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const base = (o: Order = order()): DataSet => ({
  ...emptyDataSet(),
  ingredients: [{ id: 'f', name: 'Farinha', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 }],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }],
  orders: [o],
});
const pay = (amount: number, id = 'p1', over: Partial<Payment> = {}): Payment => ({ id, amount, receivedAt: '2026-11-15', ...over });

describe('Recebimentos: cálculo', () => {
  it('total, recebido (sinal + recebimentos) e saldo pendente', () => {
    const o = order({ payments: [pay(30), pay(10, 'p2')] }); // total 100, sinal 20
    expect([orderTotal(o), totalReceived(o), balanceDue(o)]).toEqual([100, 60, 40]);
    expect(balanceDue(order())).toBe(80);
  });
  it('centavos exatos, sem erro de ponto flutuante', () => {
    const o = order({ quantity: 1, unitPrice: 1, deposit: 0, payments: Array.from({ length: 10 }, (_, i) => pay(0.1, `p${i}`)) });
    expect(totalReceived(o)).toBe(1); expect(balanceDue(o)).toBe(0);
    expect(balanceDue(order({ quantity: 3, unitPrice: 33.33, deposit: 0.1 }))).toBe(99.89); // 99,99 − 0,10
  });
  it('cobra embalagens adicionais sem alterar encomendas antigas e calcula o saldo pelo total cobrado', () => {
    const current = order({ quantity: 25, unitPrice: 2.5, deposit: 20, packagingCharge: 3.75 });
    expect(orderTotal(current)).toBe(66.25);
    expect(balanceDue(current)).toBe(46.25);

    const legacy = order({ quantity: 25, unitPrice: 2.5, deposit: 0, packagingItems: [{ packagingId: 'box', name: 'Caixa', quantity: 1, unitCost: 3.75 }] });
    expect(orderTotal(legacy)).toBe(62.5);
  });
  it('inclui adicionais uma vez no custo e no preço para calcular o lucro', () => {
    expect(calculateOrderFinancials({ quantity: 25, unitPrice: 2.5, packagingCharge: 3.75, recipeCostPerUnit: 1, additionalPackagingCost: 3.75 }))
      .toEqual({ productsTotal: 62.5, packagingCharge: 3.75, totalCharged: 66.25, estimatedCost: 28.75, estimatedProfit: 37.5, balanceDue: 66.25 });
  });
  it('saldo nunca fica negativo', () => expect(balanceDue(order({ deposit: 100 }))).toBe(0));
});

describe('Recebimentos: registrar e remover', () => {
  it('registra pagamentos parciais até quitar, com data, meio e observação', () => {
    let d = base();
    d = addPayment(d, 'o', pay(30, 'p1', { method: 'Pix', note: '1ª parcela' }));
    expect(balanceDue(d.orders[0])).toBe(50);
    d = addPayment(d, 'o', pay(50, 'p2', { receivedAt: '2026-11-20', method: 'Dinheiro' }));
    expect(balanceDue(d.orders[0])).toBe(0);
    expect(d.orders[0].payments).toEqual([pay(30, 'p1', { method: 'Pix', note: '1ª parcela' }), pay(50, 'p2', { receivedAt: '2026-11-20', method: 'Dinheiro' })]);
  });
  it('não aceita receber mais que o saldo (sem crédito nem reembolso) e não altera nada ao recusar', () => {
    const d = base();
    expect(() => addPayment(d, 'o', pay(80.01))).toThrow('maior que o saldo');
    expect(() => addPayment(d, 'o', pay(1000))).toThrow('saldo');
    expect(d.orders[0].payments).toBeUndefined();
    const paid = addPayment(d, 'o', pay(80));
    expect(() => addPayment(paid, 'o', pay(0.01, 'p2'))).toThrow('totalmente paga');
    expect(() => addPayment(paid, 'o', pay(80, 'p3'))).toThrow();
  });
  it('arredonda o recebimento para centavos antes de comparar com o saldo', () => {
    const small = base(order({ quantity: 1, unitPrice: 0.01, deposit: 0 }));
    expect(() => addPayment(small, 'o', pay(0.015))).toThrow('maior que o saldo');

    const twoCents = base(order({ quantity: 1, unitPrice: 0.02, deposit: 0 }));
    expect(addPayment(twoCents, 'o', pay(0.014)).orders[0].payments?.[0].amount).toBe(0.01);
  });
  it('rejeita valor inválido, data inválida, id repetido e encomenda inexistente', () => {
    const d = base();
    for (const amount of [0, -5, NaN, Infinity, '10' as unknown as number, 2e9]) expect(() => addPayment(d, 'o', pay(amount)), String(amount)).toThrow();
    for (const receivedAt of ['', '2026-02-31', '15/11/2026', 'hoje']) expect(() => addPayment(d, 'o', pay(10, 'p1', { receivedAt })), receivedAt).toThrow('data');
    const once = addPayment(d, 'o', pay(10));
    expect(() => addPayment(once, 'o', pay(10))).toThrow('duplicado');
    expect(() => addPayment(d, 'nao-existe', pay(10))).toThrow('não encontrada');
  });
  it('remover devolve o saldo e o campo some quando não há mais recebimentos', () => {
    let d = addPayment(addPayment(base(), 'o', pay(30)), 'o', pay(20, 'p2'));
    d = removePayment(d, 'o', 'p1');
    expect(balanceDue(d.orders[0])).toBe(60); expect(d.orders[0].payments).toEqual([pay(20, 'p2')]);
    d = removePayment(d, 'o', 'p2');
    expect('payments' in d.orders[0]).toBe(false); expect(balanceDue(d.orders[0])).toBe(80);
    expect(() => removePayment(d, 'o', 'p2')).toThrow(); expect(() => removePayment(d, 'x', 'p1')).toThrow();
  });
  it('não altera o estado original', () => {
    const d = base(); const before = JSON.stringify(d);
    addPayment(d, 'o', pay(10)); expect(JSON.stringify(d)).toBe(before);
  });
});

describe('Recebimentos: edição da encomenda', () => {
  const patch = (over: Record<string, unknown> = {}) => ({ customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 50, deliveryDate: '2026-12-01', deposit: 20, ...over });
  it('o novo total não pode ficar abaixo do que já foi recebido', () => {
    const d = addPayment(base(), 'o', pay(30)); // recebido 50
    expect(() => updateOrder(d, 'o', patch({ unitPrice: 24 }))).toThrow('abaixo do que já foi recebido'); // total 48
    expect(updateOrder(d, 'o', patch({ unitPrice: 25 })).orders[0].unitPrice).toBe(25); // total 50: exatamente o recebido
    expect(() => updateOrder(d, 'o', patch({ deposit: 80 }))).toThrow(); // 80 + 30 > 100
  });
  it('editar a encomenda preserva os recebimentos e o custo registrado', () => {
    const snap = { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' };
    const d = addPayment(base(order({ costSnapshot: snap })), 'o', pay(30));
    const next = updateOrder(d, 'o', patch({ quantity: 3, unitPrice: 60 })); // total 180
    expect(next.orders[0].payments).toEqual([pay(30)]); expect(next.orders[0].costSnapshot).toEqual(snap);
    expect(balanceDue(next.orders[0])).toBe(130);
  });
});

describe('Recebimentos: backup e migração', () => {
  const tree = (o: Record<string, unknown>) => ({ ...base(), orders: [{ ...order(), ...o }] });
  it('um backup com recebimentos é aceito e preservado', () => {
    const out = validateDataSet(tree({ payments: [pay(30, 'p1', { method: 'Pix', note: ' obs ' }), pay(10, 'p2')] }));
    expect(out.orders[0].payments).toEqual([pay(30, 'p1', { method: 'Pix', note: 'obs' }), pay(10, 'p2')]);
  });
  it('listas vazias somem (forma canônica); backups v1/v2 sem recebimentos continuam válidos', () => {
    expect('payments' in validateDataSet(tree({ payments: [] })).orders[0]).toBe(false);
    for (const version of [1, 2]) expect(validateDataSet({ ...tree({}), schemaVersion: version }).schemaVersion).toBe(4);
  });
  it('rejeita recebimentos inválidos', () => {
    const bad = (payments: unknown, re: RegExp) => expect(() => validateDataSet(tree({ payments })), JSON.stringify(payments)).toThrow(re);
    bad([pay(-1)], /valor inválido/); bad([pay(0)], /valor inválido/); bad([pay(NaN)], /valor inválido/);
    bad([pay(10, 'p1', { receivedAt: '2026-13-01' })], /data inválida/);
    bad([pay(10, 'p1', { method: 'Fiado' as never })], /meio de pagamento/);
    bad([pay(10, 'p1', { note: 'x'.repeat(201) })], /observação/);
    bad([pay(10), pay(10)], /repetido/); bad([{ amount: 10, receivedAt: '2026-11-15' }], /identificador/);
    bad([pay(80.01)], /maior que o total/); // sinal 20 + 80,01 > 100
    bad('x', /recebimentos/); bad(Array.from({ length: 101 }, (_, i) => pay(0.01, `p${i}`)), /recebimentos/);
    expect(() => validateDataSet(tree({ payments: [pay(80)] }))).not.toThrow(); // exatamente o saldo
  });
});

describe('Recebimentos: servidor e sincronização', () => {
  let s: Server;
  beforeEach(async () => { s = makeServer(); await s.issueFor('bia@exemplo.com'); });
  const orderWith = (payments?: Payment[]): Order => order({ ...(payments ? { payments } : {}) });
  const seed = async (session: Awaited<ReturnType<Server['login']>>, o: Order) => {
    const p = emptyPush(0); const d = base(o);
    p.upserts.ingredients = d.ingredients; p.upserts.recipes = d.recipes; p.upserts.orders = [o];
    return s.request('POST', '/api/sync/push', { session, body: p });
  };
  const pull = async (session: Awaited<ReturnType<Server['login']>>) => (await (await s.request('GET', '/api/sync?since=0', { session })).json()) as { orders: { data?: Order }[] };

  it('os recebimentos viajam com a encomenda, na ordem, e voltam idênticos', async () => {
    const bia = await s.login('bia@exemplo.com');
    const payments = [pay(30, 'p1', { method: 'Pix', note: 'obs' }), pay(10, 'p2', { receivedAt: '2026-11-20' })];
    expect((await seed(bia, orderWith(payments))).status).toBe(200);
    expect((await pull(bia)).orders[0].data).toEqual(orderWith(payments));
    expect(s.table('order_payments').map(r => [r.position, r.id, r.amount])).toEqual([[0, 'p1', 30], [1, 'p2', 10]]);
  });
  it('editar a lista substitui as linhas antigas; excluir a encomenda remove os recebimentos', async () => {
    const bia = await s.login('bia@exemplo.com');
    await seed(bia, orderWith([pay(30, 'p1'), pay(10, 'p2')]));
    const edit = emptyPush(1); edit.baseRevs.orders = { o: 1 }; edit.upserts.orders = [orderWith([pay(5, 'p3')])];
    expect((await s.request('POST', '/api/sync/push', { session: bia, body: edit })).status).toBe(200);
    expect(s.table('order_payments').map(r => r.id)).toEqual(['p3']);
    const clear = emptyPush(2); clear.baseRevs.orders = { o: 2 }; clear.upserts.orders = [orderWith()];
    await s.request('POST', '/api/sync/push', { session: bia, body: clear });
    expect(s.table('order_payments')).toHaveLength(0); expect((await pull(bia)).orders[0].data).toEqual(orderWith());
    const del = emptyPush(3); del.baseRevs.orders = { o: 3 }; del.deletes.orders = ['o'];
    expect((await s.request('POST', '/api/sync/push', { session: bia, body: del })).status).toBe(200);
    expect(s.table('order_payments')).toHaveLength(0); expect(s.table('orders')).toHaveLength(1); // a encomenda fica como registro lógico
  });
  it('o servidor recusa recebimentos acima do total e reenvio idêntico é "sem alteração"', async () => {
    const bia = await s.login('bia@exemplo.com');
    expect((await seed(bia, orderWith([pay(90)]))).status).toBe(400); // sinal 20 + 90 > 100
    expect(s.table('orders')).toHaveLength(0);
    expect((await seed(bia, orderWith([pay(80)]))).status).toBe(200);
    expect(await (await seed(bia, orderWith([pay(80)]))).json()).toEqual({ revision: 1, changed: false });
  });
  it('um recebimento registrado num dispositivo aparece no outro', async () => {
    const A = new Device(s, await s.login('bia@exemplo.com', 'Celular')), B = new Device(s, await s.login('bia@exemplo.com', 'Notebook'));
    A.edit(() => base()); await A.sync(); await B.sync();
    A.edit(d => addPayment(d, 'o', pay(30))); await A.sync(); await B.sync();
    expect(B.data.orders[0].payments).toEqual([pay(30)]); expect(balanceDue(B.data.orders[0])).toBe(50);
  });
  it('dois dispositivos registrando recebimentos no MESMO pedido ao mesmo tempo: o servidor vence e o recebimento perdido fica guardado', async () => {
    const A = new Device(s, await s.login('bia@exemplo.com', 'Celular')), B = new Device(s, await s.login('bia@exemplo.com', 'Notebook'));
    A.edit(() => base()); await A.sync(); await B.sync();
    A.edit(d => addPayment(d, 'o', pay(30, 'pa'))); B.edit(d => addPayment(d, 'o', pay(25, 'pb')));
    await A.sync();
    const rb = await B.sync();
    expect(rb.status).toBe('synced');
    expect(B.data.orders[0].payments).toEqual([pay(30, 'pa')]); // converge para o do servidor
    expect(rb.newConflicts).toHaveLength(1);
    expect((rb.newConflicts[0].local as Order).payments).toEqual([pay(25, 'pb')]); // o recebimento de B não se perdeu em silêncio
    await A.sync(); expect(A.data.orders).toEqual(B.data.orders);
  });
});
