import { beforeEach, describe, expect, it } from 'vitest';
import { balanceDue, orderTotal, totalReceived } from '../src/domain/payments';
import type { DataSet, Order, Payment } from '../src/domain/types';
import { financialDiff, isOpenFinancial, type ConflictRecord } from '../src/sync/engine';
import { describeFinancial, reconcileFinancial } from '../src/sync/reconcile';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

// Cenário: duas pontas (celular e notebook) lançam recebimentos na MESMA encomenda ao mesmo tempo.
const pay = (id: string, amount: number, receivedAt = '2026-11-12'): Payment => ({ id, amount, receivedAt });
const base = (): DataSet => ({ schemaVersion: 3,
  ingredients: [{ id: 'i1', name: 'Farinha', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 }],
  recipes: [{ id: 'r1', name: 'Bolo', yield: 10, items: [{ ingredientId: 'i1', quantity: 500, unit: 'g' }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }],
  orders: [{ id: 'o1', customer: 'Ana', recipeId: 'r1', quantity: 10, unitPrice: 10, deposit: 20, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z' }] }); // total 100, sinal 20
const withPayments = (d: DataSet, ...p: Payment[]): DataSet => ({ ...d, orders: d.orders.map(o => ({ ...o, payments: [...(o.payments ?? []), ...p] })) });
const order = (d: DataSet) => d.orders[0] as Order;

describe('financialDiff: só dinheiro criado AQUI e ausente no servidor', () => {
  const o = (payments: Payment[], deposit = 20, over: Partial<Order> = {}): Order => ({ ...order(base()), deposit, payments, ...over });
  it('nome do cliente alterado + recebimento só no servidor: não é perda financeira', () => {
    expect(financialDiff(o([], 20, { customer: 'Ana B.' }), o([]), o([pay('s1', 30)]))).toBeUndefined();
  });
  it('recebimento lançado aqui e ausente no servidor', () => {
    expect(financialDiff(o([pay('l1', 30)]), o([]), o([pay('s1', 40)]))?.addedPayments).toEqual([pay('l1', 30)]);
  });
  it('mesmo recebimento já presente no servidor (mesmo id): nada a reconciliar', () => {
    expect(financialDiff(o([pay('l1', 30)]), o([]), o([pay('l1', 30)]))).toBeUndefined();
  });
  it('recebimento removido aqui e ainda no servidor; e mudança do sinal', () => {
    const d = financialDiff(o([], 50), o([pay('p1', 10)]), o([pay('p1', 10)]));
    expect(d?.removedPayments).toEqual([pay('p1', 10)]);
    expect(d?.deposit).toEqual({ local: 50, server: 20 });
  });
  it('encomenda excluída no servidor com dinheiro novo aqui', () => {
    expect(financialDiff(o([pay('l1', 30)]), o([]), undefined)?.addedPayments).toHaveLength(1);
  });
});

describe('Duas pontas lançam recebimentos ao mesmo tempo (servidor real)', () => {
  let s: Server; let a: Device; let b: Device;
  beforeEach(async () => {
    s = makeServer(); await s.issueFor('bia@exemplo.test');
    a = new Device(s, await s.login('bia@exemplo.test', 'Celular')); b = new Device(s, await s.login('bia@exemplo.test', 'Notebook'));
    a.edit(() => base()); expect((await a.sync()).status).toBe('synced'); expect((await b.sync()).status).toBe('synced');
  });

  it('o recebimento perdido NÃO some: vira pendência financeira com o valor, e o servidor continua oficial', async () => {
    a.edit(d => withPayments(d, pay('pa', 30))); b.edit(d => withPayments(d, pay('pb', 25)));
    expect((await a.sync()).status).toBe('synced');
    const r = await b.sync();
    expect(r.status).toBe('synced');
    expect(order(b.data).payments).toEqual([pay('pa', 30)]); // servidor venceu
    const open = b.meta.conflicts.filter(isOpenFinancial);
    expect(open).toHaveLength(1);
    expect(open[0].financial?.addedPayments).toEqual([pay('pb', 25)]); // o valor perdido está guardado
    expect(describeFinancial(open[0])[0]).toContain('25,00');
  });

  it('somar: acrescenta o recebimento perdido, respeita o total e sincroniza para as duas pontas', async () => {
    a.edit(d => withPayments(d, pay('pa', 30))); b.edit(d => withPayments(d, pay('pb', 25)));
    await a.sync(); await b.sync();
    const c = b.meta.conflicts.find(isOpenFinancial) as ConflictRecord;
    const res = reconcileFinancial(b.data, c, 'merge', new Date());
    expect(res.conflict.resolution?.action).toBe('merge');
    expect(isOpenFinancial(res.conflict)).toBe(false);
    b.data = res.data; b.meta = { ...b.meta, conflicts: b.meta.conflicts.map(x => (x.id === c.id ? res.conflict : x)) };
    expect(totalReceived(order(b.data))).toBe(75); expect(balanceDue(order(b.data))).toBe(25);
    expect((await b.sync()).status).toBe('synced'); await a.sync();
    expect(order(a.data).payments?.map(p => p.id).sort()).toEqual(['pa', 'pb']);
  });

  it('somar que passaria do total é recusado com explicação e NADA muda (a pendência continua aberta)', async () => {
    a.edit(d => withPayments(d, pay('pa', 50))); b.edit(d => withPayments(d, pay('pb', 40))); // 20 + 50 + 40 > 100
    await a.sync(); await b.sync();
    const c = b.meta.conflicts.find(isOpenFinancial) as ConflictRecord;
    const before = JSON.stringify(b.data);
    expect(() => reconcileFinancial(b.data, c, 'merge', new Date())).toThrow(/passaria do total/);
    expect(JSON.stringify(b.data)).toBe(before);
    expect(isOpenFinancial(c)).toBe(true);
  });

  it('manter o servidor: é uma escolha explícita e fica registrada', async () => {
    a.edit(d => withPayments(d, pay('pa', 30))); b.edit(d => withPayments(d, pay('pb', 25)));
    await a.sync(); await b.sync();
    const c = b.meta.conflicts.find(isOpenFinancial) as ConflictRecord;
    const res = reconcileFinancial(b.data, c, 'keep-server', new Date('2026-11-12T16:00:00Z'));
    expect(res.data).toBe(b.data);
    expect(res.conflict.resolution).toEqual({ action: 'keep-server', at: '2026-11-12T16:00:00.000Z' });
    expect(() => reconcileFinancial(b.data, res.conflict, 'merge', new Date())).toThrow(); // já resolvida
  });

  it('encomenda excluída no outro dispositivo, com recebimento novo aqui: recuperar recria uma cópia com o recebimento', async () => {
    a.edit(d => ({ ...d, orders: [] })); b.edit(d => withPayments(d, pay('pb', 25)));
    await a.sync(); await b.sync();
    expect(b.data.orders).toHaveLength(0); // servidor venceu (excluída)
    const c = b.meta.conflicts.find(isOpenFinancial) as ConflictRecord;
    expect(c.reason).toBe('deleted-elsewhere');
    const res = reconcileFinancial(b.data, c, 'merge', new Date(), () => 'o-copia');
    expect(res.data.orders).toHaveLength(1);
    expect(res.data.orders[0]).toMatchObject({ id: 'o-copia', customer: 'Ana' });
    expect(res.data.orders[0].payments).toEqual([pay('pb', 25)]);
    b.data = res.data;
    expect((await b.sync()).status).toBe('synced');
  });

  it('a mesma pendência não é criada duas vezes ao sincronizar de novo, e conflito sem dinheiro não gera pendência financeira', async () => {
    a.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Ana A' })) }));
    b.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Ana B' })) }));
    await a.sync(); await b.sync(); await b.sync();
    expect(b.meta.conflicts.length).toBe(1);
    expect(b.meta.conflicts.filter(isOpenFinancial)).toHaveLength(0);
  });

  it('total e saldo continuam consistentes: nenhum recebimento duplicado após somar duas vezes o mesmo id', async () => {
    a.edit(d => withPayments(d, pay('pa', 30))); b.edit(d => withPayments(d, pay('pb', 25)));
    await a.sync(); await b.sync();
    const c = b.meta.conflicts.find(isOpenFinancial) as ConflictRecord;
    const once = reconcileFinancial(b.data, c, 'merge', new Date()).data;
    const twice = reconcileFinancial(once, { ...c, resolution: undefined }, 'merge', new Date()).data;
    expect(order(twice).payments).toHaveLength(2);
    expect(orderTotal(order(twice))).toBe(100);
  });
});
