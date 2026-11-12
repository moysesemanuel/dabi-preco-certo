import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveQuoteCodes, isQuoteCode, legacyQuoteCode, uniqueQuoteCode, withQuoteCodes } from '../shared/quoteCode';
import { updateOrder } from '../src/domain/edit';
import { addPayment } from '../src/domain/payments';
import type { DataSet, Order } from '../src/domain/types';
import { buildPublicQuote, createQuotesClient, whatsappShareUrl } from '../src/features/sharing/quotes';
import { emptyDataSet, isPendingConflict } from '../src/sync/engine';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

let srv: Server;
beforeEach(async () => { srv = makeServer(); await srv.issueFor('bia@exemplo.com'); });
const device = async (label: string, email = 'bia@exemplo.com') => new Device(srv, await srv.login(email, label));

const base = (): DataSet => ({ ...emptyDataSet(), ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6 }],
  recipes: [{ id: 'r', name: 'Bolo de cenoura', yield: 10, items: [{ ingredientId: 'f', quantity: 500, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }] });
const mk = (id: string, over: Partial<Order> = {}): Order => ({ id, customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 50, deposit: 10, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const newOrder = (d: DataSet, id: string, over: Partial<Order> = {}): Order => mk(id, { quoteCode: uniqueQuoteCode(new Set(d.orders.map(o => o.quoteCode!).filter(Boolean))), ...over });
const serverCodes = () => Object.fromEntries(srv.table('orders').map(r => [r.id as string, r.quote_code as string | null]));
const addOrder = (d: Device, id: string, over: Partial<Order> = {}) => d.edit(x => ({ ...x, orders: [...x.orders, newOrder(x, id, over)] }));

describe('Geração e unicidade', () => {
  it('duas sessões criam pedidos offline ao mesmo tempo: códigos diferentes, gravados e preservados na sincronização', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => base()); await A.sync(); await B.sync();
    A.offline = B.offline = true;
    for (let n = 0; n < 5; n++) { addOrder(A, `a${n}`); addOrder(B, `b${n}`); }
    expect((await A.sync()).status).toBe('offline');
    A.offline = B.offline = false;
    await A.sync(); await B.sync(); await A.sync();
    const codes = Object.values(serverCodes()); expect(codes).toHaveLength(10); expect(new Set(codes).size).toBe(10); expect(codes.every(c => isQuoteCode(c))).toBe(true);
    expect(A.data.orders.map(o => o.quoteCode).sort()).toEqual(B.data.orders.map(o => o.quoteCode).sort());
    expect(A.meta.conflicts).toEqual([]); expect(B.meta.conflicts).toEqual([]);
  });

  it('o código não muda ao editar, confirmar, entregar, receber pagamento nem ao sincronizar de novo', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => base()); addOrder(A, 'o1'); await A.sync(); await B.sync();
    const code = A.data.orders[0].quoteCode!;
    A.edit(d => updateOrder(d, 'o1', { customer: 'Ana Paula', recipeId: 'r', quantity: 3, unitPrice: 55, deliveryDate: '2026-12-05', deposit: 10 })); await A.sync();
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, status: 'Confirmado' as const })) })); await A.sync();
    A.edit(d => addPayment(d, 'o1', { id: 'p1', amount: 40, receivedAt: '2026-11-12' })); await A.sync();
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, status: 'Entregue' as const })) })); await A.sync();
    await B.sync();
    for (const d of [A, B]) expect(d.data.orders[0].quoteCode).toBe(code);
    expect(serverCodes().o1).toBe(code); expect(B.data.orders[0]).toMatchObject({ status: 'Entregue', customer: 'Ana Paula' });
  });

  it('o servidor recusa código repetido na mesma conta; o app troca o código ainda não confirmado e tudo converge', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => base()); A.edit(d => ({ ...d, orders: [newOrder(d, 'oa', { quoteCode: 'ORC-K7M42P' })] })); await A.sync(); await B.sync();
    B.edit(d => ({ ...d, orders: [...d.orders, mk('ob', { quoteCode: 'ORC-K7M42P', customer: 'Bia' })] })); // colisão forçada
    const r = await B.sync();
    expect(r.status).toBe('synced');
    const codes = serverCodes(); expect(codes.oa).toBe('ORC-K7M42P'); expect(codes.ob).not.toBe('ORC-K7M42P'); expect(isQuoteCode(codes.ob)).toBe(true);
    expect(B.data.orders.find(o => o.id === 'ob')!.quoteCode).toBe(codes.ob); expect(B.data.orders.find(o => o.id === 'oa')!.quoteCode).toBe('ORC-K7M42P');
    await A.sync(); expect(A.data.orders.find(o => o.id === 'ob')!.quoteCode).toBe(codes.ob);
  });

  it('índice único no banco: nem um envio direto consegue repetir o código na conta (mas contas diferentes podem)', async () => {
    const A = await device('A'); A.edit(() => base()); A.edit(d => ({ ...d, orders: [newOrder(d, 'o1', { quoteCode: 'ORC-K7M42P' })] })); await A.sync();
    const userId = srv.table('orders')[0].user_id as string;
    expect(() => srv.db.raw.prepare("INSERT INTO orders (user_id, id, customer, recipe_id, quantity, unit_price, deposit, delivery_date, status, created_at, rev, quote_code) VALUES (?, 'x', 'c', 'r', 1, 1, 0, '2026-12-01', 'Orçamento', '2026-11-11T10:00:00Z', 9, 'ORC-K7M42P')").run(userId)).toThrow(/UNIQUE/);
    await srv.issueFor('carla@exemplo.com'); const C = await device('C', 'carla@exemplo.com');
    C.edit(() => base()); C.edit(d => ({ ...d, orders: [newOrder(d, 'o1', { quoteCode: 'ORC-K7M42P' })] }));
    expect((await C.sync()).status).toBe('synced'); expect(srv.table('orders').filter(r => r.quote_code === 'ORC-K7M42P')).toHaveLength(2);
  });

  it('o código já gravado no servidor é permanente: um envio com outro valor, ou sem código, não o altera', async () => {
    const A = await device('A'); A.edit(() => base()); addOrder(A, 'o1'); await A.sync();
    const code = serverCodes().o1!;
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, quoteCode: 'ORC-ZZZZZZ', customer: 'Outro' })) })); await A.sync();
    expect(serverCodes().o1).toBe(code); expect(srv.table('orders')[0].customer).toBe('Outro');
    A.edit(d => ({ ...d, orders: d.orders.map(({ quoteCode: _q, ...o }) => ({ ...o, status: 'Confirmado' as const })) })); await A.sync();
    expect(serverCodes().o1).toBe(code);
    await A.sync(); expect(A.data.orders[0].quoteCode).toBe(code); // o aparelho adota o código do servidor
    expect(A.meta.conflicts.filter(isPendingConflict)).toEqual([]);
  });
});

describe('Pedidos existentes (sem código)', () => {
  it('aparelhos diferentes derivam o mesmo código; só o código é acrescentado e nada financeiro muda', async () => {
    const A = await device('A'), B = await device('B');
    const legacy = (): DataSet => ({ ...base(), orders: [mk('old1', { payments: [{ id: 'p', amount: 20, receivedAt: '2026-11-12' }], costSnapshot: { costPerUnit: 3, capturedAt: '2026-11-11T10:00:00.000Z' } }), mk('old2')] });
    A.edit(() => legacy()); await A.sync(); // enviado por uma versão antiga: sem códigos no servidor
    expect(Object.values(serverCodes())).toEqual([null, null]);
    await B.sync();
    for (const d of [A, B]) d.edit(x => ({ ...x, orders: withQuoteCodes(x.orders) })); // cada aparelho preenche ao carregar
    expect(A.data.orders.map(o => o.quoteCode)).toEqual(B.data.orders.map(o => o.quoteCode)); // determinístico
    await A.sync(); await B.sync(); await A.sync();
    expect(A.meta.conflicts).toEqual([]); expect(B.meta.conflicts).toEqual([]);
    expect(serverCodes()).toEqual({ old1: legacyQuoteCode('old1'), old2: legacyQuoteCode('old2') });
    const { quoteCode: _q, ...stripped } = A.data.orders[0]; expect(stripped).toEqual(legacy().orders[0]); // dados financeiros intactos
    expect(srv.table('order_payments')).toHaveLength(1); expect(srv.table('orders')[0].cost_per_unit).toBe(3);
  });

  it('um aparelho preenche o código enquanto o outro edita o mesmo pedido: sem conflito, nada se perde', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => ({ ...base(), orders: [mk('old1')] })); await A.sync(); await B.sync();
    A.edit(x => ({ ...x, orders: withQuoteCodes(x.orders) }));                                    // A: só acrescenta o código
    B.edit(x => ({ ...x, orders: x.orders.map(o => ({ ...o, customer: 'Cliente Novo', status: 'Confirmado' as const })) })); await B.sync(); // B: edita o pedido
    await A.sync();
    expect(A.meta.conflicts.filter(isPendingConflict)).toEqual([]);
    expect(A.data.orders[0]).toMatchObject({ customer: 'Cliente Novo', status: 'Confirmado', quoteCode: legacyQuoteCode('old1') });
    await A.sync(); await B.sync();
    expect(serverCodes().old1).toBe(legacyQuoteCode('old1')); expect(B.data.orders[0].quoteCode).toBe(legacyQuoteCode('old1'));
  });

  it('um pedido derivado nunca repete o código de um pedido novo da mesma lista', () => {
    const forced = legacyQuoteCode('old1');
    const codes = effectiveQuoteCodes([{ id: 'old1', createdAt: '2026-01-01T00:00:00Z' }, { id: 'new1', createdAt: '2026-02-01T00:00:00Z', quoteCode: forced }]);
    expect(new Set(codes.values()).size).toBe(2);
  });
});

describe('Orçamento público, WhatsApp, revogação e republicação', () => {
  const settings = { cupSizeMl: 240, businessName: 'Doces da Bia', businessPhone: '5541999990000' };
  const issue = { issuedAt: '2026-11-11', validUntil: '2026-11-18' };
  async function setup() {
    const session = await srv.login('bia@exemplo.com');
    return { session, client: createQuotesClient('https://api.exemplo.test', () => session.csrf, srv.fetchFor(session)) };
  }
  it('o número do orçamento é o código permanente: aparece na página do cliente, na lista e no WhatsApp; republicar e revogar não o alteram', async () => {
    const { client } = await setup();
    const order = mk('o1', { quoteCode: 'ORC-K7M42P', customer: 'Maria Secreta' });
    const built = buildPublicQuote(order, base().recipes[0], settings, issue);
    if (!built.ok) throw new Error(built.error);
    expect(built.quote.quoteNumber).toBe('ORC-K7M42P');
    const first = await client.publish(built.quote); if (!first.ok) throw new Error('publish');
    const page = await (await srv.request('GET', `/o/${first.value.id}`)).text();
    expect(page).toContain('ORC-K7M42P'); expect(page).not.toContain('Maria Secreta'); expect(page).not.toContain('o1');
    const wa = decodeURIComponent(whatsappShareUrl(built.quote, first.value.url).split('text=')[1]); expect(wa).toContain('nº ORC-K7M42P'); expect(wa).toContain(first.value.url);
    expect((await client.revoke(first.value.id)).ok).toBe(true);
    // republica o mesmo pedido, mesmo depois de editado e confirmado: o mesmo código, com outro token de link
    const edited = { ...order, status: 'Confirmado' as const, unitPrice: 60 };
    const again = buildPublicQuote(edited, base().recipes[0], settings, issue); if (!again.ok) throw new Error(again.error);
    const second = await client.publish(again.quote); if (!second.ok) throw new Error('publish 2');
    expect(second.value.id).not.toBe(first.value.id); expect(again.quote.quoteNumber).toBe('ORC-K7M42P');
    const list = await client.list(); if (!list.ok) throw new Error('list');
    expect(list.value.map(q => [q.quoteNumber, q.status]).sort()).toEqual([['ORC-K7M42P', 'active'], ['ORC-K7M42P', 'revoked']]);
    expect((await srv.request('GET', `/o/${first.value.id}`)).status).toBe(410); // o link revogado continua revogado
  });
  it('o código NÃO é credencial: não existe consulta por código e o token do link não contém o código', async () => {
    const { client } = await setup();
    const built = buildPublicQuote(mk('o1', { quoteCode: 'ORC-K7M42P' }), base().recipes[0], settings, issue); if (!built.ok) throw new Error(built.error);
    const pub = await client.publish(built.quote); if (!pub.ok) throw new Error('publish');
    for (const path of ['/o/ORC-K7M42P', '/o/K7M42P', '/api/quotes/ORC-K7M42P', '/api/orders/ORC-K7M42P', '/api/sync?code=ORC-K7M42P']) expect([401, 404, 400, 410]).toContain((await srv.request('GET', path)).status);
    expect(pub.value.id).not.toContain('K7M42P'); expect(pub.value.url).not.toContain('ORC');
  });
});

describe('Isolamento entre contas', () => {
  it('a conta B não recebe pedidos nem códigos da conta A', async () => {
    await srv.issueFor('carla@exemplo.com');
    const A = await device('A'); A.edit(() => base()); addOrder(A, 'o1'); await A.sync();
    const C = await device('C', 'carla@exemplo.com'); await C.sync();
    expect(C.data.orders).toEqual([]); expect(srv.table('orders').every(r => r.user_id === srv.table('orders')[0].user_id)).toBe(true);
  });
});
