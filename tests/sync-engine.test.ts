import { beforeEach, describe, expect, it } from 'vitest';
import type { PullResponse, PushRequest } from '../shared/sync';
import { SYNC_LIMITS } from '../shared/sync';
import type { DataSet, Ingredient, Order, Recipe } from '../src/domain/types';
import { createHttpSyncApi } from '../src/sync/api';
import { applyPull, buildPushes, emptyDataSet, emptyMeta, findDanglingRefs, rebaseLocal, SyncError, syncOnce, type SyncApi, type SyncMeta } from '../src/sync/engine';
import { BASE, makeServer, ORIGIN, type Server, type Session } from './helpers/server';

const ing = (id: string, over: Partial<Ingredient> = {}): Ingredient => ({ id, name: `Ingrediente ${id}`, unit: 'g', purchaseQuantity: 1000, purchasePrice: 6, ...over });
const rec = (id: string, ingredientId: string, over: Partial<Recipe> = {}): Recipe => ({ id, name: `Receita ${id}`, yield: 10, items: [{ ingredientId, quantity: 500, unit: 'g' }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20, ...over });
const ord = (id: string, recipeId: string, over: Partial<Order> = {}): Order => ({ id, customer: 'Ana', recipeId, quantity: 2, unitPrice: 5, deposit: 3, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const data = (p: Partial<DataSet> = {}): DataSet => ({ ...emptyDataSet(), ...p });
const pullOf = (p: Partial<PullResponse> = {}): PullResponse => ({ revision: 1, ingredients: [], recipes: [], orders: [], ...p });
const E = <T,>(id: string, rev: number, d?: T) => (d === undefined ? { id, rev, deleted: true } : { id, rev, deleted: false, data: d });
const metaWith = (baseline: DataSet, revision: number, revs: SyncMeta['revs']): SyncMeta => ({ ...emptyMeta(), revision, baseline, revs });

describe('Motor: alterações locais e envios', () => {
  it('detecta o que é novo, alterado e excluído, com as revisões conhecidas', () => {
    const base = data({ ingredients: [ing('a'), ing('b')] });
    const meta = metaWith(base, 4, { ingredients: { a: 2, b: 3 }, recipes: {}, orders: {} });
    const local = data({ ingredients: [ing('a', { purchasePrice: 9 }), ing('c')] }); // a alterado, b excluído, c novo
    const [push] = buildPushes(local, meta);
    expect(push.baseRevision).toBe(4);
    expect(push.upserts.ingredients.map(i => i.id)).toEqual(['a', 'c']);
    expect(push.deletes.ingredients).toEqual(['b']);
    expect(push.baseRevs.ingredients).toEqual({ a: 2, b: 3 }); // c é novo: sem revisão
  });
  it('sem alterações locais não há envio', () => {
    const base = data({ ingredients: [ing('a')], recipes: [rec('r', 'a')] });
    expect(buildPushes(base, metaWith(base, 1, { ingredients: { a: 1 }, recipes: { r: 1 }, orders: {} }))).toEqual([]);
  });
  it('divide em blocos de até 100 alterações, ingredientes → receitas → encomendas, e exclusões ao contrário', () => {
    const ingredients = Array.from({ length: 150 }, (_, i) => ing(`i${i}`));
    const recipes = Array.from({ length: 30 }, (_, i) => rec(`r${i}`, 'i0'));
    const orders = Array.from({ length: 40 }, (_, i) => ord(`o${i}`, 'r0'));
    const pushes = buildPushes(data({ ingredients, recipes, orders }), emptyMeta());
    expect(pushes).toHaveLength(3);
    expect(pushes.every(p => [...p.upserts.ingredients, ...p.upserts.recipes, ...p.upserts.orders].length <= SYNC_LIMITS.maxChangesPerPush)).toBe(true);
    const sequence = pushes.flatMap(p => [...p.upserts.ingredients.map(() => 'i'), ...p.upserts.recipes.map(() => 'r'), ...p.upserts.orders.map(() => 'o')]).join('');
    expect(sequence).toMatch(/^i{150}r{30}o{40}$/); // dependências sempre antes de quem depende
    const base = data({ ingredients: [ing('a')], recipes: [rec('r', 'a')], orders: [ord('o', 'r')] });
    const del = buildPushes(data(), metaWith(base, 1, { ingredients: { a: 1 }, recipes: { r: 1 }, orders: { o: 1 } }));
    expect(del).toHaveLength(1); expect(Object.keys(del[0].deletes)).toEqual(['ingredients', 'recipes', 'orders']);
  });
  it('as configurações locais novas entram no primeiro envio', () => {
    const [p] = buildPushes(data({ settings: { cupSizeMl: 250 } }), emptyMeta());
    expect(p.upserts.settings).toEqual({ cupSizeMl: 250 });
  });
  it('detecta referências quebradas', () => {
    expect(findDanglingRefs(data({ recipes: [rec('r', 'sumiu')], orders: [ord('o', 'sumiu')] }))).toHaveLength(2);
    expect(findDanglingRefs(data({ ingredients: [ing('a')], recipes: [rec('r', 'a')], orders: [ord('o', 'r')] }))).toEqual([]);
  });
});

describe('Motor: mesclagem (3 vias)', () => {
  const NOW = new Date('2026-11-12T10:00:00Z');
  it('aceita o que só mudou no servidor e mantém o que só mudou aqui', () => {
    const base = data({ ingredients: [ing('a'), ing('b')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1, b: 1 }, recipes: {}, orders: {} });
    const local = data({ ingredients: [ing('a'), ing('b', { purchasePrice: 11 })] }); // aqui: b mudou
    const out = applyPull(local, meta, pullOf({ revision: 2, ingredients: [E('a', 2, ing('a', { purchasePrice: 8 })), E('c', 2, ing('c'))] }), NOW);
    expect(out.local.ingredients.map(i => [i.id, i.purchasePrice])).toEqual([['a', 8], ['b', 11], ['c', 6]]);
    expect(out.conflicts).toEqual([]);
    expect(out.meta.revision).toBe(2); expect(out.meta.revs.ingredients).toEqual({ a: 2, b: 1, c: 2 });
    expect(out.meta.baseline.ingredients.find(i => i.id === 'b')!.purchasePrice).toBe(6); // b continua "alterado aqui" até ser enviado
  });
  it('mesma entidade alterada nos dois lados: o servidor vence e a versão local fica GUARDADA', () => {
    const base = data({ ingredients: [ing('a')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1 }, recipes: {}, orders: {} });
    const mine = ing('a', { purchasePrice: 100 }), theirs = ing('a', { purchasePrice: 8 });
    const out = applyPull(data({ ingredients: [mine] }), meta, pullOf({ revision: 2, ingredients: [E('a', 2, theirs)] }), NOW);
    expect(out.local.ingredients[0]).toEqual(theirs);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ kind: 'ingredients', entityId: 'a', reason: 'edited-elsewhere', local: mine, server: theirs, at: NOW.toISOString() });
    expect(out.meta.conflicts).toHaveLength(1);
    expect(buildPushes(out.local, out.meta)).toEqual([]); // nada a reenviar: convergiu
  });
  it('alterações idênticas dos dois lados não são conflito', () => {
    const base = data({ ingredients: [ing('a')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1 }, recipes: {}, orders: {} });
    const same = ing('a', { purchasePrice: 8 });
    const out = applyPull(data({ ingredients: [same] }), meta, pullOf({ revision: 2, ingredients: [E('a', 2, same)] }), NOW);
    expect(out.conflicts).toEqual([]); expect(buildPushes(out.local, out.meta)).toEqual([]);
  });
  it('exclusão no servidor de algo que não mudei é aplicada; se eu tinha editado, é conflito e a edição fica guardada', () => {
    const base = data({ ingredients: [ing('a'), ing('b')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1, b: 1 }, recipes: {}, orders: {} });
    const local = data({ ingredients: [ing('a'), ing('b', { purchasePrice: 50 })] });
    const out = applyPull(local, meta, pullOf({ revision: 2, ingredients: [E<Ingredient>('a', 2), E<Ingredient>('b', 2)] }), NOW);
    expect(out.local.ingredients).toEqual([]);
    expect(out.conflicts.map(c => [c.entityId, c.reason])).toEqual([['b', 'deleted-elsewhere']]);
    expect(out.conflicts[0].local).toEqual(ing('b', { purchasePrice: 50 }));
    expect(out.meta.revs.ingredients).toEqual({ a: 2, b: 2 }); // guarda a revisão da exclusão (permite recriar)
  });
  it('se o servidor excluiu um ingrediente do qual uma receita NOVA daqui depende, ele é restaurado (sem referência quebrada)', () => {
    const base = data({ ingredients: [ing('a')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1 }, recipes: {}, orders: {} });
    const local = data({ ingredients: [ing('a')], recipes: [rec('r', 'a')] });
    const out = applyPull(local, meta, pullOf({ revision: 2, ingredients: [E<Ingredient>('a', 2)] }), NOW);
    expect(out.local.ingredients.map(i => i.id)).toEqual(['a']);
    expect(findDanglingRefs(out.local)).toEqual([]);
    expect(out.conflicts.map(c => c.reason)).toContain('restored');
    const [push] = buildPushes(out.local, out.meta);
    expect(push.upserts.ingredients.map(i => i.id)).toEqual(['a']); expect(push.baseRevs.ingredients.a).toBe(2); // recria com a revisão da exclusão
  });
  it('o mesmo vale para receita excluída lá e encomenda nova aqui (em cadeia até o ingrediente)', () => {
    const base = data({ ingredients: [ing('a')], recipes: [rec('r', 'a')] });
    const meta = metaWith(base, 1, { ingredients: { a: 1 }, recipes: { r: 1 }, orders: {} });
    const local = data({ ingredients: [ing('a')], recipes: [rec('r', 'a')], orders: [ord('o', 'r')] });
    const out = applyPull(local, meta, pullOf({ revision: 2, recipes: [E<Recipe>('r', 2)], ingredients: [E<Ingredient>('a', 2)] }), NOW);
    expect(findDanglingRefs(out.local)).toEqual([]);
    expect(out.local.recipes.map(r => r.id)).toEqual(['r']); expect(out.local.ingredients.map(i => i.id)).toEqual(['a']);
  });
  it('configurações: servidor vence em conflito, preservando a local', () => {
    const base = data({ settings: { cupSizeMl: 240 } });
    const meta = { ...metaWith(base, 1, { ingredients: {}, recipes: {}, orders: {}, settings: 1 }) };
    const out = applyPull(data({ settings: { cupSizeMl: 200 } }), meta, pullOf({ revision: 2, settings: { rev: 2, data: { cupSizeMl: 250 } } }), NOW);
    expect(out.local.settings).toEqual({ cupSizeMl: 250 });
    expect(out.conflicts[0]).toMatchObject({ kind: 'settings', local: { cupSizeMl: 200 }, server: { cupSizeMl: 250 } });
    const noLocalEdit = applyPull(data({ settings: { cupSizeMl: 240 } }), meta, pullOf({ revision: 2, settings: { rev: 2, data: { cupSizeMl: 250 } } }), NOW);
    expect(noLocalEdit.local.settings).toEqual({ cupSizeMl: 250 }); expect(noLocalEdit.conflicts).toEqual([]);
  });
  it('não altera os objetos recebidos', () => {
    const base = data({ ingredients: [ing('a')] }), meta = metaWith(base, 1, { ingredients: { a: 1 }, recipes: {}, orders: {} }), local = data({ ingredients: [ing('a')] });
    const before = JSON.stringify([base, meta, local]);
    applyPull(local, meta, pullOf({ revision: 2, ingredients: [E('a', 2, ing('a', { purchasePrice: 1 }))] }), NOW);
    expect(JSON.stringify([base, meta, local])).toBe(before);
  });
  it('rebaseLocal: edição feita DURANTE a sincronização é preservada', () => {
    const started = data({ ingredients: [ing('a'), ing('b')] });
    const synced = data({ ingredients: [ing('a', { purchasePrice: 8 }), ing('b', { purchasePrice: 9 }), ing('c')] }); // resultado da sincronização
    const current = data({ ingredients: [ing('a'), ing('b', { purchasePrice: 77 })] }); // o usuário editou b enquanto sincronizava
    const out = rebaseLocal(current, started, synced);
    expect(out.ingredients.map(i => [i.id, i.purchasePrice])).toEqual([['a', 8], ['b', 77], ['c', 6]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Integração: dispositivos reais (motor + cliente HTTP) conversando com o Worker real
// ---------------------------------------------------------------------------------------------------------------
class Device {
  data: DataSet = emptyDataSet();
  meta: SyncMeta = emptyMeta();
  offline = false;
  dropNextPushResponse = false;
  status401 = false;
  readonly api: SyncApi;
  constructor(private server: Server, private session: Session) {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const isPush = String(url).endsWith('/api/sync/push');
      const res = await server.handle(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: this.status401 ? 'dabi_session=invalida' : session.cookie, origin: ORIGIN } }), server.env);
      if (isPush && this.dropNextPushResponse) { this.dropNextPushResponse = false; throw new TypeError('rede caiu depois do servidor gravar'); }
      return res;
    }) as typeof fetch;
    this.api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => session.csrf, fetchImpl });
  }
  edit(fn: (d: DataSet) => DataSet) { this.data = fn(this.data); }
  async sync(opts: { allowInitialMerge?: boolean } = {}) {
    const started = this.data;
    const r = await syncOnce(this.api, started, this.meta, opts);
    if (r.status === 'synced' || r.status === 'offline' || r.status === 'needs-attention' || r.status === 'error') { this.data = rebaseLocal(this.data, started, r.local); this.meta = r.meta; }
    return r;
  }
}

let srv: Server;
const device = async (email = 'bia@exemplo.com', label = 'Celular') => new Device(srv, await srv.login(email, label));
beforeEach(async () => { srv = makeServer(); await srv.issueFor('bia@exemplo.com'); });
const norm = (d: DataSet) => ({ ingredients: [...d.ingredients].sort((a, b) => (a.id < b.id ? -1 : 1)), recipes: [...d.recipes].sort((a, b) => (a.id < b.id ? -1 : 1)), orders: [...d.orders].sort((a, b) => (a.id < b.id ? -1 : 1)), settings: d.settings });
const full = (): DataSet => data({ ingredients: [ing('f'), ing('a', { unit: 'kg', purchaseQuantity: 1 })], recipes: [rec('r', 'f')], orders: [ord('o', 'r', { costSnapshot: { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' } })], settings: { cupSizeMl: 250 } });

describe('Dois dispositivos', () => {
  it('os dados criados num dispositivo aparecem, idênticos, no outro', async () => {
    const A = await device(), B = await device('bia@exemplo.com', 'Notebook');
    A.edit(() => full());
    expect((await A.sync()).status).toBe('synced');
    const rb = await B.sync();
    expect(rb).toMatchObject({ status: 'synced', pushed: 0 });
    expect(norm(B.data)).toEqual(norm(A.data));
    expect(B.meta.revision).toBe(A.meta.revision);
    expect(srv.table('orders')[0]).toMatchObject({ cost_per_unit: 4 }); // o custo histórico viaja junto
  });
  it('edições em entidades diferentes se combinam; ambos convergem', async () => {
    const A = await device(), B = await device('bia@exemplo.com', 'Notebook');
    A.edit(() => full()); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'f' ? { ...i, purchasePrice: 9 } : i)) }));
    B.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, status: 'Entregue' as const })), ingredients: [...d.ingredients, ing('novo')] }));
    await A.sync(); await B.sync(); await A.sync();
    expect(norm(A.data)).toEqual(norm(B.data));
    expect(A.data.ingredients.find(i => i.id === 'f')!.purchasePrice).toBe(9);
    expect(A.data.orders[0].status).toBe('Entregue'); expect(A.data.ingredients.map(i => i.id)).toContain('novo');
    expect(A.meta.conflicts).toEqual([]); expect(B.meta.conflicts).toEqual([]);
  });
  it('mesma entidade nos dois: o primeiro a sincronizar vence; a edição do outro fica GUARDADA, sem perda silenciosa', async () => {
    const A = await device(), B = await device('bia@exemplo.com', 'Notebook');
    A.edit(() => full()); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'f' ? { ...i, purchasePrice: 9 } : i)) }));
    B.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'f' ? { ...i, purchasePrice: 100 } : i)) }));
    await A.sync();
    const rb = await B.sync();
    expect(rb.status).toBe('synced');
    expect(B.data.ingredients.find(i => i.id === 'f')!.purchasePrice).toBe(9); // servidor vence
    expect(rb.newConflicts).toHaveLength(1);
    expect(rb.newConflicts[0]).toMatchObject({ kind: 'ingredients', entityId: 'f', reason: 'edited-elsewhere' });
    expect((rb.newConflicts[0].local as Ingredient).purchasePrice).toBe(100); // a versão perdida continua disponível para o usuário
    expect(B.meta.conflicts).toHaveLength(1);
    await A.sync();
    expect(norm(A.data)).toEqual(norm(B.data));
  });
  it('exclusões se propagam, sem apagar nada de verdade no servidor', async () => {
    const A = await device(), B = await device('bia@exemplo.com', 'Notebook');
    A.edit(() => full()); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, orders: [] })); await A.sync();
    await B.sync();
    expect(B.data.orders).toEqual([]);
    expect(srv.table('orders')).toHaveLength(1); expect(srv.table('orders')[0].deleted_at).not.toBeNull();
    A.edit(d => ({ ...d, recipes: [], ingredients: [] })); expect((await A.sync()).status).toBe('synced');
    await B.sync(); expect(norm(B.data)).toEqual(norm(A.data));
  });
  it('excluir no servidor algo que o outro dispositivo usa em um item novo: o item é restaurado e tudo converge', async () => {
    const A = await device(), B = await device('bia@exemplo.com', 'Notebook');
    A.edit(() => data({ ingredients: [ing('f'), ing('x')], recipes: [rec('r', 'f')] })); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: d.ingredients.filter(i => i.id !== 'x') })); await A.sync(); // exclui x
    B.edit(d => ({ ...d, recipes: [...d.recipes, rec('r2', 'x')] })); // B cria uma receita que usa x
    expect((await B.sync()).status).toBe('synced');
    expect(findDanglingRefs(B.data)).toEqual([]);
    expect(B.data.ingredients.map(i => i.id).sort()).toEqual(['f', 'x']); // x foi restaurado
    await A.sync(); expect(norm(A.data)).toEqual(norm(B.data));
  });
});

describe('Falhas de rede e recuperação', () => {
  it('sem conexão: nada se perde nem se corrompe; ao voltar, tudo é enviado', async () => {
    const A = await device();
    A.edit(() => full());
    A.offline = true;
    const off = await A.sync();
    expect(off.status).toBe('offline');
    expect(norm(A.data)).toEqual(norm(full())); expect(A.meta).toEqual(emptyMeta());
    A.edit(d => ({ ...d, orders: [...d.orders, ord('o2', 'r')] }));
    A.offline = false;
    expect((await A.sync()).status).toBe('synced');
    expect(srv.table('orders')).toHaveLength(2);
  });
  it('a rede cai DEPOIS de o servidor gravar: repetir não duplica nem gera conflito consigo mesmo', async () => {
    const A = await device();
    A.edit(() => full());
    A.dropNextPushResponse = true;
    expect((await A.sync()).status).toBe('offline'); // o cliente não sabe que o servidor gravou
    expect(srv.table('ingredients')).toHaveLength(2);
    const again = await A.sync();
    expect(again.status).toBe('synced'); expect(again.newConflicts).toEqual([]);
    expect(srv.table('ingredients')).toHaveLength(2); expect(srv.table('recipe_items')).toHaveLength(1);
    const rev = srv.table('sync_state')[0].revision;
    expect((await A.sync()).status).toBe('synced');
    expect(srv.table('sync_state')[0].revision).toBe(rev); // sincronizar de novo não gera revisões
  });
  it('sessão expirada: "não autorizado", dados locais intactos', async () => {
    const A = await device();
    A.edit(() => full());
    A.status401 = true;
    const r = await A.sync();
    expect(r.status).toBe('unauthorized');
    expect(norm(A.data)).toEqual(norm(full()));
  });
  it('rate limit e erros do servidor viram status, sem lançar exceção', async () => {
    const fail = (status: number): SyncApi => createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => 'x', fetchImpl: (async () => new Response('{}', { status })) as typeof fetch });
    expect((await syncOnce(fail(429), full(), emptyMeta())).status).toBe('error');
    expect((await syncOnce(fail(500), full(), emptyMeta())).status).toBe('error');
    expect((await syncOnce(fail(401), full(), emptyMeta())).status).toBe('unauthorized');
    const broken: SyncApi = { pull: async () => { throw new SyncError('offline', 'x'); }, push: async () => ({ ok: true, revision: 1, changed: true }) };
    expect((await syncOnce(broken, full(), emptyMeta())).status).toBe('offline');
  });
  it('dados locais que o servidor recusa (ex.: legado inválido) ficam intactos e pedem atenção', async () => {
    const A = await device();
    A.edit(() => data({ ingredients: [ing('f', { purchasePrice: -5 })] }));
    const r = await A.sync();
    expect(r.status).toBe('needs-attention');
    expect(A.data.ingredients[0].purchasePrice).toBe(-5);
    expect(srv.table('ingredients')).toHaveLength(0);
  });
  it('um erro inesperado (bug) não é engolido', async () => {
    const boom: SyncApi = { pull: async () => { throw new Error('bug'); }, push: async () => ({ ok: true, revision: 1, changed: true }) };
    await expect(syncOnce(boom, full(), emptyMeta())).rejects.toThrow('bug');
  });
});

describe('Importação inicial e volume', () => {
  it('conta vazia: os dados locais existentes são enviados sem perdas', async () => {
    const A = await device();
    A.edit(() => full());
    expect((await A.sync()).status).toBe('synced');
    expect(norm((await (async () => { const B = await device('bia@exemplo.com', 'Notebook'); await B.sync(); return B; })()).data)).toEqual(norm(full()));
  });
  it('dispositivo com dados locais + conta com dados: pede decisão e não altera nada até confirmar; depois une sem duplicar', async () => {
    const A = await device();
    A.edit(() => full()); await A.sync();
    const B = await device('bia@exemplo.com', 'Notebook');
    B.edit(() => data({ ingredients: [ing('f'), ing('so-no-b')] })); // 'f' é igual ao da conta; 'so-no-b' só existe aqui
    const first = await B.sync();
    expect(first.status).toBe('needs-decision');
    expect(B.data.ingredients.map(i => i.id)).toEqual(['f', 'so-no-b']); expect(srv.table('ingredients')).toHaveLength(2);
    const merged = await B.sync({ allowInitialMerge: true });
    expect(merged.status).toBe('synced');
    expect(B.data.ingredients.map(i => i.id).sort()).toEqual(['a', 'f', 'so-no-b']);
    expect(B.data.recipes.map(r => r.id)).toEqual(['r']); expect(merged.newConflicts).toEqual([]); // ids iguais com conteúdo igual não são conflito
    await A.sync(); expect(norm(A.data)).toEqual(norm(B.data));
  });
  it('mais de 100 alterações: enviadas em blocos, na ordem das dependências, e o outro dispositivo recebe tudo', async () => {
    const A = await device();
    A.edit(() => data({
      ingredients: Array.from({ length: 230 }, (_, i) => ing(`i${i}`)),
      recipes: Array.from({ length: 40 }, (_, i) => rec(`r${i}`, `i${i}`)),
      orders: Array.from({ length: 120 }, (_, i) => ord(`o${i}`, `r${i % 40}`)),
    }));
    const r = await A.sync();
    expect(r.status).toBe('synced'); expect(r.pushed).toBe(390);
    expect(srv.table('ingredients')).toHaveLength(230); expect(srv.table('orders')).toHaveLength(120);
    const B = await device('bia@exemplo.com', 'Notebook');
    expect((await B.sync()).status).toBe('synced');
    expect(norm(B.data)).toEqual(norm(A.data));
  });
});

describe('Isolamento entre contas no cliente', () => {
  it('outra conta sincronizando nunca recebe nem altera dados da primeira', async () => {
    await srv.issueFor('ana@exemplo.com');
    const A = await device(), X = await device('ana@exemplo.com', 'Celular da Ana');
    A.edit(() => full()); await A.sync();
    expect((await X.sync()).status).toBe('synced');
    expect(X.data).toEqual(emptyDataSet());
    X.edit(() => data({ ingredients: [ing('f', { name: 'Da Ana' })] })); await X.sync();
    await A.sync();
    expect(A.data.ingredients.find(i => i.id === 'f')!.name).toBe('Ingrediente f');
  });
});
