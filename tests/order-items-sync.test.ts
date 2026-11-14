/**
 * Etapa 11 — encomendas com vários itens contra o Worker REAL (SQLite): sincronização entre aparelhos, offline, conflitos,
 * pagamentos em dois aparelhos, Worker desatualizado, isolamento entre contas e migração 0012.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ITEM_ID } from '../shared/dataset';
import { uniqueQuoteCode } from '../shared/quoteCode';
import { emptyPush, SYNC_PROTOCOL, type PullResponse } from '../shared/sync';
import { createOrder } from '../src/domain/orders';
import { addPayment, orderTotal, totalReceived } from '../src/domain/payments';
import type { DataSet, Order } from '../src/domain/types';
import { createHttpSyncApi } from '../src/sync/api';
import { emptyMeta, isOpenFinancial, syncOnce } from '../src/sync/engine';
import { reconcileFinancial } from '../src/sync/reconcile';
import { createTestD1 } from './helpers/d1';
import { Device } from './helpers/device';
import { BASE, makeServer, ORIGIN, type Server, type Session } from './helpers/server';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const catalog = (): Omit<DataSet, 'orders'> => ({
  schemaVersion: 5,
  ingredients: [{ id: 'i1', name: 'Base', unit: 'un', purchaseQuantity: 100, purchasePrice: 50 }],
  packagings: [{ id: 'forminha', name: 'Forminha', purchasePrice: 5, purchaseQuantity: 100, active: true }, { id: 'caixa', name: 'Caixa', purchasePrice: 12, purchaseQuantity: 1, active: true }],
  recipes: ['brig', 'beij', 'bolo'].map(id => ({ id, name: { brig: 'Brigadeiro Gourmet', beij: 'Beijinho', bolo: 'Bolo de cenoura' }[id]!, yield: 1, items: [{ ingredientId: 'i1', quantity: 1 }], packagingItems: id === 'bolo' ? [] : [{ packagingId: 'forminha', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 })),
});
let n = 0;
const newOrder = (d: DataSet, id = 'o1', deposit = 0): Order => createOrder(d, { customer: 'Ana', deliveryDate: '2026-12-20', deposit, packagingItems: [{ packagingId: 'caixa', name: 'Caixa', quantity: 1, unitCost: 12 }],
  items: [{ recipeId: 'brig', quantity: 50, unitPrice: 2.5 }, { recipeId: 'beij', quantity: 30, unitPrice: 2.5 }, { recipeId: 'bolo', quantity: 1, unitPrice: 65 }] }, { id, quoteCode: uniqueQuoteCode(new Set()), now: NOW, newItemId: () => `item${++n}` });

let s: Server; let bia: Session; let A: Device; let B: Device;
async function seeded() {
  A.edit(d => ({ ...d, ...catalog() }));
  A.edit(d => ({ ...d, orders: [newOrder(d)] }));
  const first = await A.sync(); if (first.status !== 'synced') throw new Error(`${first.status}: ${first.message}`);
  expect((await B.sync()).status).toBe('synced');
}
beforeEach(async () => {
  s = makeServer(NOW); await s.issueFor('bia@exemplo.com'); bia = await s.login('bia@exemplo.com', 'Notebook');
  A = new Device(s, bia); B = new Device(s, await s.login('bia@exemplo.com', 'Celular'));
});

describe('Sincronização entre aparelhos', () => {
  it('a encomenda com 3 itens chega inteira ao outro aparelho, com snapshots; o D1 guarda os itens e espelha o primeiro nas colunas antigas', async () => {
    await seeded();
    expect(B.data.orders[0]).toEqual(A.data.orders[0]);
    expect(B.data.orders[0].items.map(i => [i.recipeName, i.quantity, i.unitPrice])).toEqual([['Brigadeiro Gourmet', 50, 2.5], ['Beijinho', 30, 2.5], ['Bolo de cenoura', 1, 65]]);
    expect(B.data.orders[0].items[0].costSnapshot?.packagingItems?.[0].packagingId).toBe('forminha');
    expect(orderTotal(B.data.orders[0])).toBe(277);
    const rows = s.db.raw.prepare('SELECT position, id, recipe_id, quantity, unit_price, cost_per_unit FROM order_items ORDER BY position').all();
    expect(rows).toHaveLength(3);
    expect(s.db.raw.prepare("SELECT recipe_id, quantity, unit_price FROM orders WHERE id = 'o1'").get()).toEqual({ recipe_id: 'brig', quantity: 50, unit_price: 2.5 });
    expect((await A.sync()).status).toBe('synced'); expect(A.meta.conflicts).toEqual([]); // nada a reenviar: sem loop
  });
  it('item adicionado e removido OFFLINE: fica guardado, é enviado ao reconectar e o outro aparelho recebe a lista exata', async () => {
    await seeded();
    A.offline = true;
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, items: [...o.items.filter(i => i.recipeId !== 'beij'), { id: 'novo', recipeId: 'beij', recipeName: 'Beijinho', quantity: 10, unitPrice: 3 }] })) }));
    expect((await A.sync()).status).toBe('offline');
    expect(A.data.orders[0].items.map(i => i.id)).toContain('novo');
    A.offline = false;
    const back = await A.sync(); expect(back.message ?? back.status).toBe('synced');
    await B.sync();
    expect(B.data.orders[0].items.map(i => [i.recipeId, i.quantity])).toEqual([['brig', 50], ['bolo', 1], ['beij', 10]]);
    expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM order_items').get()).toEqual({ n: 3 }); // regravação completa, sem sobras
  });
  it('edição simultânea dos itens nos dois aparelhos: conflito real, nada é sobrescrito nem descartado', async () => {
    await seeded();
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, items: o.items.slice(0, 2) })) }));
    B.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, items: o.items.map(i => (i.recipeId === 'bolo' ? { ...i, quantity: 2 } : i)) })) }));
    expect((await A.sync()).status).toBe('synced');
    const r = await B.sync();
    expect(r.newConflicts.some(c => c.kind === 'orders' && c.pending)).toBe(true);
    expect(B.meta.conflicts.some(c => c.kind === 'orders' && c.pending)).toBe(true);
    expect(B.data.orders[0].items.find(i => i.recipeId === 'bolo')?.quantity).toBe(2); // versão local preservada
    expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM order_items').get()).toEqual({ n: 2 }); // a nuvem não foi sobrescrita
  });
  it('recebimento em dois aparelhos: o orçamento vira Confirmado; a soma reconcilia sem duplicar, e reenviar não duplica', async () => {
    await seeded();
    expect(A.data.orders[0].status).toBe('Orçamento');
    A.edit(d => addPayment(d, 'o1', { id: 'pa', amount: 50, receivedAt: '2026-11-15' }));
    B.edit(d => addPayment(d, 'o1', { id: 'pb', amount: 30, receivedAt: '2026-11-15' }));
    A.dropNextPushResponse = true; await A.sync(); // o servidor grava, a resposta se perde
    expect((await A.sync()).status).toBe('synced'); // reenvio idêntico: nada duplicado
    await B.sync();
    const pending = B.meta.conflicts.find(isOpenFinancial)!;
    expect(pending.financial?.addedPayments.map(p => p.id)).toEqual(['pb']);
    expect(B.data.orders[0]).toMatchObject({ status: 'Confirmado', payments: [{ id: 'pa' }] }); // servidor aplicado: confirmado
    const merged = reconcileFinancial(B.data, pending, 'merge', NOW);
    B.data = merged.data; B.meta = { ...B.meta, conflicts: B.meta.conflicts.map(c => (c.id === pending.id ? merged.conflict : c)) };
    expect((await B.sync()).status).toBe('synced'); await A.sync();
    for (const d of [A.data, B.data]) { expect(d.orders[0].status).toBe('Confirmado'); expect(d.orders[0].payments?.map(p => p.id).sort()).toEqual(['pa', 'pb']); expect(totalReceived(d.orders[0])).toBe(80); }
    expect(s.db.raw.prepare("SELECT status FROM orders WHERE id = 'o1'").get()).toEqual({ status: 'Confirmado' });
    expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM order_payments').get()).toEqual({ n: 2 });
  });
  it('pedido criado com sinal sincroniza Confirmado, e o status não regride depois de recarregar/sincronizar de novo', async () => {
    A.edit(d => ({ ...d, ...catalog() })); A.edit(d => ({ ...d, orders: [newOrder(d, 'o2', 50)] }));
    expect((await A.sync()).status).toBe('synced'); await B.sync(); await B.sync();
    expect(B.data.orders[0]).toMatchObject({ status: 'Confirmado', deposit: 50 });
  });
});

describe('Integridade no servidor', () => {
  it('excluir uma receita usada só pelo 2º item de uma encomenda é recusado (422)', async () => {
    await seeded();
    A.edit(d => ({ ...d, recipes: d.recipes.filter(r => r.id !== 'beij') }));
    const p = emptyPush(A.meta.revision); p.deletes.recipes.push('beij'); p.baseRevs.recipes.beij = A.meta.revs.recipes.beij;
    const r = await s.request('POST', '/api/sync/v2/push', { session: bia, body: p });
    expect(r.status).toBe(422);
    expect(s.db.raw.prepare("SELECT deleted_at FROM recipes WHERE id = 'beij'").get()).toEqual({ deleted_at: null });
  });
  it('o servidor valida os itens com as regras do backup (receita inexistente, lista vazia, item repetido)', async () => {
    await seeded();
    const order = A.data.orders[0];
    for (const items of [[], [order.items[0], order.items[0]], [{ ...order.items[0], recipeId: 'nao-existe' }]]) {
      const p = emptyPush(A.meta.revision); p.upserts.orders.push({ ...order, items }); p.baseRevs.orders.o1 = A.meta.revs.orders.o1;
      expect((await s.request('POST', '/api/sync/v2/push', { session: bia, body: p })).status).toBeGreaterThanOrEqual(400);
    }
    expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM order_items').get()).toEqual({ n: 3 });
  });
  it('isolamento: outra conta não vê os itens, e os mesmos ids nela criam linhas próprias', async () => {
    await seeded();
    await s.issueFor('carla@exemplo.com'); const carla = await s.login('carla@exemplo.com');
    const pulled = await (await s.request('GET', '/api/sync/v2?since=0', { session: carla })).json() as PullResponse;
    expect(pulled.orders).toEqual([]);
    const C = new Device(s, carla); C.edit(d => ({ ...d, ...catalog() })); C.edit(d => ({ ...d, orders: [{ ...newOrder(d), items: [newOrder(d).items[2]] }] }));
    expect((await C.sync()).status).toBe('synced');
    expect(s.db.raw.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = 'o1'").get()).toEqual({ n: 4 });
    await A.sync(); expect(A.data.orders[0].items).toHaveLength(3);
  });
});

describe('Versões incompatíveis: nunca perder itens', () => {
  it('rotas antigas de sincronização respondem 426 sem ler nem gravar (app antigo não descarta itens)', async () => {
    await seeded();
    const before = s.db.raw.prepare('SELECT revision FROM sync_state').get();
    const legacyBody = { ...emptyPush(0), upserts: { ingredients: [], recipes: [], orders: [{ id: 'o1', customer: 'X', recipeId: 'brig', quantity: 1, unitPrice: 1, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-11T10:00:00.000Z' }] } };
    const push = await s.request('POST', '/api/sync/push', { session: bia, body: legacyBody });
    const pull = await s.request('GET', '/api/sync?since=0', { session: bia });
    expect([push.status, pull.status]).toEqual([426, 426]);
    expect(await pull.json()).toMatchObject({ error: 'CLIENT_OUTDATED' });
    expect(s.db.raw.prepare('SELECT revision FROM sync_state').get()).toEqual(before);
    expect(s.db.raw.prepare('SELECT COUNT(*) AS n FROM order_items').get()).toEqual({ n: 3 });
  });
  const local = (): DataSet => { const d = { ...catalog(), orders: [] } as DataSet; return { ...d, orders: [newOrder(d)] }; };
  it('Worker ANTIGO (sem a rota v2 → 404): o app não envia nada, avisa e mantém os itens no aparelho', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => { calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`); return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 }); }) as typeof fetch;
    const api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => 'x', fetchImpl });
    const data = local(); const r = await syncOnce(api, data, emptyMeta());
    expect(r.status).toBe('needs-attention'); expect(r.message).toMatch(/não suporta encomendas com vários produtos/);
    expect(r.local).toEqual(data); expect(calls.every(c => c.startsWith('GET'))).toBe(true);
  });
  it('servidor que responde ao pull SEM declarar o protocolo atual: nada é aplicado nem enviado', async () => {
    let pushes = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') !== 'GET') { pushes++; return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ revision: 9, ingredients: [], recipes: [], orders: [{ id: 'o1', rev: 9, deleted: false, data: { id: 'o1', customer: 'Ana', recipeId: 'brig', quantity: 1, unitPrice: 1 } }] }), { status: 200 });
    }) as typeof fetch;
    const api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => 'x', fetchImpl });
    const data = local(); const r = await syncOnce(api, data, emptyMeta());
    expect(r.status).toBe('needs-attention'); expect(r.local).toEqual(data); expect(pushes).toBe(0);
    expect(SYNC_PROTOCOL).toBe(2);
  });
  it('o Worker novo declara o protocolo no pull', async () => {
    const body = await (await s.request('GET', '/api/sync/v2?since=0', { session: bia })).json() as PullResponse;
    expect(body.protocol).toBe(SYNC_PROTOCOL);
  });
});

describe('Encomendas antigas no D1 e migração 0012', () => {
  const MIGRATIONS = join(__dirname, '..', 'worker', 'migrations');
  it('0012 é aditiva: não altera nenhuma linha existente; encomendas antigas são lidas como UM item e reenviar não gera conflito', async () => {
    const db = createTestD1({ upTo: '0011_order_packaging_charge.sql' });
    const srv = makeServer(NOW, { db }); await srv.issueFor('bia@exemplo.com'); const ses = await srv.login('bia@exemplo.com');
    const userId = (db.raw.prepare("SELECT id FROM users WHERE email = 'bia@exemplo.com'").get() as { id: string }).id;
    db.raw.prepare('INSERT INTO sync_state (user_id, revision, updated_at) VALUES (?, 5, ?) ON CONFLICT(user_id) DO UPDATE SET revision = 5').run(userId, NOW.toISOString());
    db.raw.prepare("INSERT INTO ingredients (user_id,id,name,unit,purchase_quantity,purchase_price,rev) VALUES (?,'i1','Base','un',100,50,1)").run(userId);
    db.raw.prepare("INSERT INTO recipes (user_id,id,name,yield,packaging_per_unit,labor_total,extra_total,desired_margin,rev) VALUES (?,'bolo','Bolo',1,0,0,0,50,1)").run(userId);
    db.raw.prepare("INSERT INTO recipe_items (user_id,recipe_id,position,ingredient_id,quantity) VALUES (?,'bolo',0,'i1',1)").run(userId);
    db.raw.prepare("INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,quote_code) VALUES (?,'old','Bia','bolo',2,50,10,'2026-12-01','Orçamento','2026-11-01T10:00:00.000Z',21,'2026-11-01T10:00:00.000Z',2,'ORC-ABCDEF')").run(userId);
    const before = JSON.stringify(db.raw.prepare('SELECT * FROM orders').all());
    db.raw.exec(readFileSync(join(MIGRATIONS, '0012_order_items.sql'), 'utf8'));
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM orders').all())).toBe(before);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM order_items').get()).toEqual({ n: 0 });
    const D = new Device(srv, ses); const E = new Device(srv, await srv.login('bia@exemplo.com', 'Outro'));
    expect((await D.sync()).status).toBe('synced');
    expect(D.data.orders[0]).toMatchObject({ status: 'Orçamento', deposit: 10, quoteCode: 'ORC-ABCDEF', items: [{ id: LEGACY_ITEM_ID, recipeId: 'bolo', quantity: 2, unitPrice: 50, costSnapshot: { costPerUnit: 21 } }] });
    expect(D.data.orders[0].items[0].recipeName).toBeUndefined();
    // Editar no aparelho novo grava os itens; o outro aparelho recebe sem conflito.
    await E.sync();
    D.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Bia Souza' })) }));
    expect((await D.sync()).status).toBe('synced'); expect((await E.sync()).status).toBe('synced');
    expect(E.meta.conflicts).toEqual([]); expect(E.data.orders[0]).toEqual(D.data.orders[0]);
    expect(db.raw.prepare('SELECT id, recipe_id, quantity, unit_price, cost_per_unit FROM order_items').all()).toEqual([{ id: LEGACY_ITEM_ID, recipe_id: 'bolo', quantity: 2, unit_price: 50, cost_per_unit: 21 }]);
  });
  it('a migração 0012 não contém instruções destrutivas', () => {
    const text = readFileSync(join(MIGRATIONS, '0012_order_items.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(text).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER\s+TABLE\s+\w+\s+(DROP|RENAME))\b/i);
  });
});

it('ORIGIN do teste é a do app (sanidade do helper)', () => expect(ORIGIN).toMatch(/^http/));
