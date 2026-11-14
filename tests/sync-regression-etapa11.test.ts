/**
 * Regressão: "Falha ao sincronizar" no staging após a Etapa 11.
 *
 * Causa comprovada: o app guardava `packagingItems: []` nas encomendas sem embalagem adicional (cadastro e edição); o Worker grava
 * '[]' e devolve o campo OMITIDO. A comparação tratava "lista vazia" e "ausente" como diferentes. Efeitos:
 *  1. Ao salvar uma edição sem mudança real, o único "envio pendente" era a lista vazia. Cada ciclo enviava (aceito: changed=true,
 *     revisão +1), o eco voltava sem o campo, a base coincidia com o eco e o envio se repetia: 4 tentativas → status 'error'
 *     ("Não foi possível concluir…" → "Falha ao sincronizar"), com novas tentativas automáticas (revisão 1410, 1411…).
 *  2. Ao criar a encomenda, o eco do próprio envio virava um conflito falso ("alterado em outro dispositivo").
 */
import { describe, expect, it } from 'vitest';
import { uniqueQuoteCode } from '../shared/quoteCode';
import { sameEntity, SYNC_PROTOCOL, type PullResponse, type PushRequest } from '../shared/sync';
import { deriveIndicator } from '../src/account/syncIndicator';
import { createOrder, updateOrder } from '../src/domain/orders';
import { addPayment } from '../src/domain/payments';
import type { DataSet, Order } from '../src/domain/types';
import { createHttpSyncApi } from '../src/sync/api';
import { emptyMeta, healConflicts, NON_CONVERGENT_MESSAGE, syncOnce, type SyncApi, type SyncTrace } from '../src/sync/engine';
import { Device } from './helpers/device';
import { BASE, makeServer, type Server, type Session } from './helpers/server';

const NOW = new Date('2026-11-14T13:49:16.856Z');
const catalog = (): Omit<DataSet, 'orders'> => ({
  schemaVersion: 5,
  ingredients: [{ id: 'i1', name: 'Base', unit: 'un', purchaseQuantity: 100, purchasePrice: 50 }],
  packagings: [{ id: 'pk', name: 'Forminha brigadeiro', purchasePrice: 14, purchaseQuantity: 100, active: true }],
  recipes: [['r1', 'Bolo Teste'], ['r2', 'Bolo teste Safari'], ['r3', 'Brigadeiro Gourmet']].map(([id, name]) => ({ id, name, yield: 1, items: [{ ingredientId: 'i1', quantity: 1 }], ...(id === 'r3' ? { packagingItems: [{ packagingId: 'pk', quantityPerUnit: 1 }] } : {}), packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 })),
});
/** A encomenda da evidência: 3 receitas com custos distintos, embalagem só no snapshot do 3º item, sinal 54, sem embalagens adicionais. */
const evidenceOrder = (d: DataSet): Order => createOrder(d, { customer: 'Teste', deliveryDate: '2026-11-16', deposit: 54, packagingItems: [],
  items: [{ recipeId: 'r1', quantity: 36, unitPrice: 0.51 }, { recipeId: 'r2', quantity: 1, unitPrice: 11.64 }, { recipeId: 'r3', quantity: 25, unitPrice: 2.5 }] }, { id: 'o1', quoteCode: uniqueQuoteCode(new Set()), now: NOW });
const revision = (s: Server) => (s.db.raw.prepare('SELECT revision FROM sync_state').get() as { revision: number }).revision;
/** Patch do formulário de edição (sempre manda a lista de embalagens, vazia quando não há). */
const formPatch = (o: Order, over: Partial<Parameters<typeof updateOrder>[2]> = {}) => ({ customer: o.customer, deliveryDate: o.deliveryDate, deposit: o.deposit, packagingItems: o.packagingItems ?? [], packagingCharge: o.packagingCharge ?? 0, items: o.items.map(i => ({ id: i.id, recipeId: i.recipeId, quantity: i.quantity, unitPrice: i.unitPrice })), ...over });

async function setup() {
  const s = makeServer(NOW); await s.issueFor('bia@exemplo.com');
  const sa: Session = await s.login('bia@exemplo.com', 'Notebook'), sb: Session = await s.login('bia@exemplo.com', 'Celular');
  const A = new Device(s, sa), B = new Device(s, sb);
  A.edit(d => ({ ...d, ...catalog() })); expect((await A.sync()).status).toBe('synced');
  A.edit(d => ({ ...d, orders: [evidenceOrder(d)] }));
  return { s, A, B, sb };
}

describe('Causa raiz: lista vazia de embalagens × campo omitido pelo servidor', () => {
  it('criar a encomenda sincroniza sem conflito falso com o eco do próprio envio', async () => {
    const { A } = await setup();
    const r = await A.sync();
    expect(r.status).toBe('synced'); expect(r.pushed).toBe(1);
    expect(A.meta.conflicts).toEqual([]);
    expect(A.data.orders[0].items).toHaveLength(3);
  });
  it('salvar a edição SEM mudança real (outro aparelho) conclui: nenhum envio redundante, revisão não dispara, sem "Falha ao sincronizar"', async () => {
    const { s, A, B } = await setup(); await A.sync(); expect((await B.sync()).status).toBe('synced');
    const before = revision(s);
    B.edit(d => updateOrder(d, 'o1', formPatch(d.orders[0]), NOW));
    const r = await B.sync();
    expect(r.status).toBe('synced'); expect(r.pushed).toBe(0); expect(revision(s)).toBe(before);
    const again = await B.sync(); expect(again).toMatchObject({ status: 'synced', pushed: 0 }); expect(revision(s)).toBe(before);
  });
  it('dados JÁ gravados por versões anteriores (lista vazia no IndexedDB) não geram envio nem conflito', async () => {
    const { s, A, B } = await setup(); await A.sync(); await B.sync();
    const before = revision(s);
    B.data = { ...B.data, orders: B.data.orders.map(o => ({ ...o, packagingItems: [], items: o.items.map(i => (i.costSnapshot && !i.costSnapshot.packagingItems ? { ...i, costSnapshot: { ...i.costSnapshot, packagingItems: [] } } : i)) })) };
    const r = await B.sync();
    expect(r).toMatchObject({ status: 'synced', pushed: 0 }); expect(revision(s)).toBe(before); expect(B.meta.conflicts).toEqual([]);
  });
  it('conflito falso pendente criado pela versão anterior se fecha sozinho (versões idênticas); nada é perdido', () => {
    const d = { ...catalog(), orders: [] } as DataSet; const order = evidenceOrder(d);
    const local = { ...order, packagingItems: [] }, server = { ...order }; delete (server as Partial<Order>).packagingItems;
    const meta = { ...emptyMeta(), conflicts: [{ id: 'c', kind: 'orders' as const, entityId: 'o1', at: NOW.toISOString(), reason: 'edited-elsewhere' as const, local, server, base: null, serverRev: 9, pending: true }] };
    const healed = healConflicts({ ...d, orders: [local] }, meta, NOW);
    expect(healed.conflicts[0]).toMatchObject({ pending: false, resolution: { action: 'identical' } });
    expect(healed.baseline.orders[0]).toEqual(server); expect(healed.revs.orders.o1).toBe(9);
  });
  it('a equivalência vale só para listas VAZIAS: embalagens reais continuam sendo comparadas (sem mascarar diferenças)', () => {
    const d = { ...catalog(), orders: [] } as DataSet; const o = evidenceOrder(d);
    const box = [{ packagingId: 'pk', name: 'Caixa', quantity: 1, unitCost: 12 }];
    expect(sameEntity({ ...o, packagingItems: [] }, o)).toBe(true);
    expect(sameEntity({ ...o, packagingItems: box }, o)).toBe(false);
    expect(sameEntity({ ...o, items: o.items.slice(0, 2) }, o)).toBe(false); // itens a menos nunca são "iguais"
    expect(sameEntity({ ...o, items: [...o.items].reverse() }, o)).toBe(false); // ordem dos itens é significativa
    const withSnapPack = o.items[2]; const noSnapPack = { ...withSnapPack, costSnapshot: { ...withSnapPack.costSnapshot!, packagingItems: undefined } };
    expect(sameEntity({ ...o, items: [o.items[0], o.items[1], noSnapPack] }, o)).toBe(false); // snapshot com embalagem continua distinto
  });
  it('o domínio já não produz lista vazia (forma canônica, igual à do servidor); remover todas as embalagens remove o campo', () => {
    const d = { ...catalog(), orders: [] } as DataSet; const o = evidenceOrder(d);
    expect('packagingItems' in o).toBe(false);
    const withBox = updateOrder({ ...d, orders: [o] }, 'o1', formPatch(o, { packagingItems: [{ packagingId: 'pk', name: 'Caixa', quantity: 1, unitCost: 2 }], packagingCharge: 2 }), NOW).orders[0];
    expect(withBox.packagingItems).toHaveLength(1);
    const cleared = updateOrder({ ...d, orders: [withBox] }, 'o1', formPatch(withBox, { packagingItems: [], packagingCharge: 0 }), NOW).orders[0];
    expect('packagingItems' in cleared).toBe(false);
  });
});

/** API em memória que reproduz a sequência da evidência (revisão 1410 → push aceito 1411 → eco). */
function evidenceApi(initial: Order, opts: { echo?: (o: Order) => Order } = {}) {
  let rev = 1410; let stored: Order = initial; const log: string[] = [];
  const echo = (o: Order) => { const { packagingItems, ...rest } = o; const copy = structuredClone(rest) as Order; if (packagingItems?.length) copy.packagingItems = packagingItems; return opts.echo ? opts.echo(copy) : copy; };
  const api: SyncApi = {
    async pull(since) { log.push(`GET since=${since} → 200 rev ${rev}`); return { protocol: SYNC_PROTOCOL, revision: rev, ingredients: [], recipes: [], orders: since < rev ? [{ id: stored.id, rev, deleted: false, data: echo(stored) }] : [], packagings: [] } as PullResponse; },
    async push(req: PushRequest) { stored = req.upserts.orders[0] ?? stored; rev += 1; log.push(`POST → 200 {revision:${rev},changed:true}`); return { ok: true, revision: rev, changed: true }; },
  };
  return { api, log, rev: () => rev };
}

describe('Sequência da evidência: pull 1410 → push aceito 1411 → confirmação', () => {
  const base = () => { const d = { ...catalog(), orders: [] } as DataSet; return { ...d, orders: [evidenceOrder(d)] }; };
  /** Aparelho que já tem o catálogo confirmado pelo servidor (revisão 1409) e ainda não viu a encomenda. */
  const known = () => { const d = { ...catalog(), orders: [] } as DataSet; return { local: d, meta: { ...emptyMeta(), revision: 1409, baseline: structuredClone(d), revs: { ...emptyMeta().revs, ingredients: { i1: 1 }, recipes: { r1: 1, r2: 1, r3: 1 }, packagings: { pk: 1 } } } }; };
  it('a revisão local passa a 1411, a sincronização seguinte não envia nada e não há conflito artificial', async () => {
    const data = base(); const server = evidenceApi(data.orders[0]);
    const k = known(); const first = await syncOnce(server.api, k.local, k.meta);
    expect(first.status).toBe('synced'); expect(first.meta.revision).toBe(1410);
    const local = updateOrder(first.local, 'o1', formPatch(first.local.orders[0], { customer: 'Teste editado' }), NOW);
    const traces: SyncTrace[] = [];
    const r = await syncOnce(server.api, local, first.meta, { trace: e => traces.push(e) });
    expect(r).toMatchObject({ status: 'synced', pushed: 1 }); expect(r.meta.revision).toBe(1411); expect(r.meta.revs.orders.o1).toBe(1411);
    expect(r.meta.conflicts).toEqual([]); expect(r.local.orders[0].items).toHaveLength(3);
    expect(server.log.slice(-3)).toEqual(['GET since=1410 → 200 rev 1410', 'POST → 200 {revision:1411,changed:true}', 'GET since=1410 → 200 rev 1411']);
    expect(traces.map(t => t.phase).join(',')).toBe('pull,merge,push,pull,merge,done');
    expect(JSON.stringify(traces)).not.toMatch(/Teste|customer|0\.51|ORC-/); // diagnóstico sem conteúdo nem dados pessoais
    const next = await syncOnce(server.api, r.local, r.meta);
    expect(next).toMatchObject({ status: 'synced', pushed: 0 }); expect(server.rev()).toBe(1411);
  });
  it('servidor que aceita mas NÃO aplica a mudança dos itens (eco igual à base): para após 1 envio, com causa clara, e a edição local não some', async () => {
    const data = base(); const original = data.orders[0].items;
    const server = evidenceApi(data.orders[0], { echo: o => ({ ...o, items: original }) }); // simula um Worker que ignora alterações nos itens
    const k = known(); const first = await syncOnce(server.api, k.local, k.meta);
    expect(first.status).toBe('synced');
    const mine = updateOrder(first.local, 'o1', formPatch(first.local.orders[0], { items: formPatch(first.local.orders[0]).items.slice(1) }), NOW); // total 74,14 ≥ sinal 54
    const r = await syncOnce(server.api, mine, first.meta);
    expect(r.status).toBe('needs-attention'); expect(r.message).toBe(NON_CONVERGENT_MESSAGE);
    expect(server.rev()).toBe(1411); // um envio só: sem laço de escritas
    expect(r.local.orders[0].items).toHaveLength(2); // a edição local é preservada (nada descartado)
  });
});

describe('Falhas reais continuam visíveis e com causa', () => {
  const fixed = (() => { const d = { ...catalog(), orders: [] } as DataSet; return { ...d, orders: [evidenceOrder(d)] }; })();
  const local = () => structuredClone(fixed);
  const respond = (status: number, body: string | object = {}) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const run = (fetchImpl: typeof fetch, timeoutMs?: number) => syncOnce(createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => 'x', fetchImpl, timeoutMs }), local(), emptyMeta(), { allowInitialMerge: true });
  it.each([
    [401, 'unauthorized', /sessão expirou/],
    [426, 'needs-attention', /não suporta encomendas com vários produtos/],
    [500, 'error', /HTTP 500/],
  ])('HTTP %i → %s', async (status, expected, message) => {
    const r = await run(respond(status, { error: 'X' }));
    expect(r.status).toBe(expected); expect(r.message).toMatch(message); expect(r.local).toEqual(local());
  });
  it('timeout → offline (dados preservados)', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError'))))) as unknown as typeof fetch;
    const r = await run(hang, 20);
    expect(r.status).toBe('offline'); expect(r.message).toMatch(/não respondeu a tempo/);
  });
  it('JSON inválido no pull e na confirmação do push → erro do servidor, nunca exceção solta', async () => {
    expect(await run(respond(200, '{nao-json'))).toMatchObject({ status: 'error', message: 'Resposta inválida do servidor.' });
    let call = 0;
    const pushBroken = (async (_u: string, init: RequestInit = {}) => ((init.method ?? 'GET') === 'GET' ? new Response(JSON.stringify({ protocol: 2, revision: 0, ingredients: [], recipes: [], orders: [], packagings: [] }), { status: 200 }) : (call++, new Response('ok', { status: 200 })))) as unknown as typeof fetch;
    expect(await run(pushBroken)).toMatchObject({ status: 'error', message: 'Resposta inválida do servidor.' }); expect(call).toBe(1);
  });
  it('409 no envio (conflito/concorrência) relê e tenta de novo; persistente vira erro com mensagem, sem laço infinito', async () => {
    let pushes = 0;
    const conflict = (async (_u: string, init: RequestInit = {}) => ((init.method ?? 'GET') === 'GET' ? new Response(JSON.stringify({ protocol: 2, revision: 0, ingredients: [], recipes: [], orders: [], packagings: [] }), { status: 200 }) : (pushes++, new Response(JSON.stringify({ error: 'STALE', revision: 0 }), { status: 409 })))) as unknown as typeof fetch;
    const r = await run(conflict);
    expect(r.status).toBe('error'); expect(pushes).toBe(4);
  });
  it('o indicador mostra a causa conhecida no detalhe ("Falha ao sincronizar" com HTTP 500)', () => {
    const ind = deriveIndicator({ sync: { phase: 'error', message: 'O servidor não respondeu como esperado (HTTP 500). Seus dados continuam neste dispositivo.', blocked: null }, hasPending: true, conflicts: 0, entitled: true });
    expect(ind.label).toBe('Falha ao sincronizar'); expect(ind.detail).toMatch(/HTTP 500/); expect(ind.detail).toMatch(/salvas neste dispositivo/);
  });
});

describe('Idempotência, recuperação e proteção de dados (Worker real)', () => {
  it('push aceito seguido de falha no pull: dados locais preservados; ao reconectar conclui sem duplicar recebimentos', async () => {
    const { s, A, B } = await setup(); await A.sync(); await B.sync();
    A.edit(d => addPayment(d, 'o1', { id: 'pay-1', amount: 20, receivedAt: '2026-11-15' }));
    A.dropNextPushResponse = true; // servidor grava; a resposta se perde (equivale a falhar depois do push)
    expect((await A.sync()).status).toBe('offline');
    const r = await A.sync();
    expect(r.status).toBe('synced');
    expect(s.db.raw.prepare("SELECT COUNT(*) AS n FROM order_payments WHERE id = 'pay-1'").get()).toEqual({ n: 1 });
    await B.sync();
    for (const d of [A.data, B.data]) { expect(d.orders[0].payments?.map(p => p.id)).toEqual(['pay-1']); expect(d.orders[0].deposit).toBe(54); expect(d.orders[0].status).toBe('Confirmado'); expect(d.orders[0].items).toHaveLength(3); }
    expect(A.data.orders[0].items[2].costSnapshot?.packagingItems?.[0].unitCost).toBe(0.14); // snapshot não recalculado
  });
  it('recarregar após o ACK (metadados relidos) não reenvia nada; offline retoma e conclui', async () => {
    const { s, A } = await setup(); await A.sync();
    const reloaded = new Device(s, (A as unknown as { session: Session }).session);
    reloaded.data = structuredClone(A.data); reloaded.meta = structuredClone(A.meta);
    const before = revision(s);
    expect(await reloaded.sync()).toMatchObject({ status: 'synced', pushed: 0 }); expect(revision(s)).toBe(before);
    reloaded.offline = true;
    reloaded.edit(d => updateOrder(d, 'o1', formPatch(d.orders[0], { customer: 'Teste offline' }), NOW));
    expect((await reloaded.sync()).status).toBe('offline');
    reloaded.offline = false;
    expect(await reloaded.sync()).toMatchObject({ status: 'synced', pushed: 1 }); expect(revision(s)).toBe(before + 1);
  });
  it('edição de um item, inclusão e remoção nos dois aparelhos convergem; contas distintas seguem isoladas', async () => {
    const { s, A, B } = await setup(); await A.sync(); await B.sync();
    A.edit(d => updateOrder(d, 'o1', formPatch(d.orders[0], { items: [...formPatch(d.orders[0]).items.slice(1), { recipeId: 'r1', quantity: 10, unitPrice: 0.6 }] }), NOW));
    expect((await A.sync()).status).toBe('synced'); expect((await B.sync()).status).toBe('synced');
    expect(B.data.orders[0].items.map(i => [i.recipeId, i.quantity])).toEqual([['r2', 1], ['r3', 25], ['r1', 10]]);
    expect(A.meta.conflicts).toEqual([]); expect(B.meta.conflicts).toEqual([]);
    await s.issueFor('carla@exemplo.com'); const carla = await s.login('carla@exemplo.com');
    const pulled = await (await s.request('GET', '/api/sync/v2?since=0', { session: carla })).json() as PullResponse;
    expect(pulled.orders).toEqual([]);
  });
});
