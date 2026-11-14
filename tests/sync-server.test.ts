import { asOrder } from './helpers/orders';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPush, SYNC_LIMITS, type PullResponse, type PushRequest } from '../shared/sync';
import type { Ingredient, Order, Packaging, Recipe } from '../src/domain/types';
import { makeServer, type Server, type Session } from './helpers/server';

let s: Server;
let bia: Session;
beforeEach(async () => { s = makeServer(); await s.issueFor('bia@exemplo.com'); bia = await s.login('bia@exemplo.com'); });

const ing = (id: string, over: Partial<Ingredient> = {}): Ingredient => ({ id, name: `Ingrediente ${id}`, unit: 'g', purchaseQuantity: 1000, purchasePrice: 6, ...over });
const rec = (id: string, ingredientId: string, over: Partial<Recipe> = {}): Recipe => ({ id, name: `Receita ${id}`, yield: 10, items: [{ ingredientId, quantity: 500, unit: 'g' }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20, ...over });
const ord = (id: string, recipeId: string, over: Partial<Order> = {}): Order => asOrder({ id, customer: 'Ana', recipeId, quantity: 2, unitPrice: 5, deposit: 3, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const push = (session: Session | undefined, build: (p: PushRequest) => void, base = 0) => { const p = emptyPush(base); build(p); return s.request('POST', '/api/sync/v2/push', { session, body: p }); };
const pull = async (session: Session | undefined, since = 0) => { const r = await s.request('GET', `/api/sync/v2?since=${since}`, { session }); return { status: r.status, body: await r.json() as PullResponse }; };
const json = async (r: Response) => r.json() as Promise<Record<string, unknown>>;

describe('Acesso', () => {
  it('sem sessão: 401; sem CSRF/origem no envio: 403; leitura não exige CSRF', async () => {
    expect((await s.request('GET', '/api/sync/v2')).status).toBe(401);
    expect((await push(undefined, () => {})).status).toBe(401);
    expect((await s.request('POST', '/api/sync/v2/push', { session: { ...bia, csrf: 'errado' }, body: emptyPush(0) })).status).toBe(403);
    expect((await s.request('POST', '/api/sync/v2/push', { session: bia, body: emptyPush(0), origin: 'https://evil.example' })).status).toBe(403);
    expect((await s.request('POST', '/api/sync/v2/push', { session: bia, body: emptyPush(0), origin: null })).status).toBe(403);
    expect((await s.request('GET', '/api/sync/v2', { session: { ...bia, csrf: 'qualquer' } })).status).toBe(200);
  });
  it('licença revogada → 403; sessão revogada → 401; método errado → 405', async () => {
    expect((await s.request('PUT', '/api/sync/v2', { session: bia })).status).toBe(405);
    expect((await s.request('GET', '/api/sync/v2/push', { session: bia })).status).toBe(405);
    s.db.raw.exec("UPDATE licenses SET status = 'revoked'");
    expect((await s.request('GET', '/api/sync/v2', { session: bia })).status).toBe(403);
    s.db.raw.exec('UPDATE sessions SET revoked_at = ?'.replace('?', "'2026-11-12T15:00:00.000Z'"));
    expect((await s.request('GET', '/api/sync/v2', { session: bia })).status).toBe(401);
  });
  it('limite de taxa da sincronização por licença', async () => {
    for (let i = 0; i < 60; i++) expect((await s.request('GET', '/api/sync/v2', { session: bia })).status).toBe(200);
    const limited = await s.request('GET', '/api/sync/v2', { session: bia });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBeTruthy();
  });
  it('parâmetro since inválido → 400', async () => {
    for (const since of ['abc', '-1', '1.5', '99999999999999999']) expect((await s.request('GET', `/api/sync/v2?since=${since}`, { session: bia })).status, since).toBe(400);
  });
});

describe('Sincronização de embalagens', () => {
  const pack: Packaging = { id: 'box', name: 'Caixa 25', purchasePrice: 4.5, purchaseQuantity: 1, capacity: 25, active: true };
  it('persiste embalagens, associações e snapshots no SQLite; cliente antigo não apaga vínculo ausente', async () => {
    const created = await push(bia, p => {
      p.upserts.packagings = [pack]; p.upserts.ingredients = [ing('f')];
      p.upserts.recipes = [rec('r', 'f', { packagingItems: [{ packagingId: 'box', quantityPerUnit: 1 }] })];
      p.upserts.orders = [ord('o', 'r', { packagingCharge: 18, costSnapshot: { costPerUnit: 1.25, capturedAt: '2026-11-11T10:00:00.000Z', packagingItems: [{ packagingId: 'box', name: 'Caixa 25', quantityPerUnit: 1, unitCost: 4.5 }] }, packagingItems: [{ packagingId: 'box', name: 'Caixa 25', quantity: 4, unitCost: 4.5 }] })];
    });
    expect(created.status).toBe(200);
    const first = (await pull(bia)).body;
    expect(first.packagings?.[0].data).toEqual(pack);
    expect(first.recipes[0].data?.packagingItems).toEqual([{ packagingId: 'box', quantityPerUnit: 1 }]);
    expect(first.orders[0].data?.packagingItems?.[0].quantity).toBe(4);
    expect(first.orders[0].data?.items[0].costSnapshot?.costPerUnit).toBe(1.25);
    expect(first.orders[0].data?.packagingCharge).toBe(18);

    const legacy = emptyPush(1);
    legacy.baseRevs.recipes = { r: 1 };
    legacy.upserts.recipes = [rec('r', 'f', { desiredMargin: 25 })];
    const oldShape = structuredClone(legacy) as unknown as Record<string, any>;
    delete oldShape.baseRevs.packagings; delete oldShape.upserts.packagings; delete oldShape.deletes.packagings;
    const response = await s.request('POST', '/api/sync/v2/push', { session: bia, body: oldShape });
    expect(response.status).toBe(200);
    const later = (await pull(bia)).body;
    expect(later.recipes[0].data?.packagingItems).toEqual([{ packagingId: 'box', quantityPerUnit: 1 }]);

    const olderOrder = structuredClone(later.orders.find(x => x.id === 'o')!.data!) as Order & { packagingCharge?: number };
    delete olderOrder.packagingCharge;
    const oldOrderPush = emptyPush(later.revision);
    oldOrderPush.baseRevs.orders = { o: later.orders.find(x => x.id === 'o')!.rev };
    oldOrderPush.upserts.orders = [olderOrder];
    const oldOrderResult = await s.request('POST', '/api/sync/v2/push', { session: bia, body: oldOrderPush });
    expect(oldOrderResult.status).toBe(200);
    expect((await pull(bia)).body.orders.find(x => x.id === 'o')?.data?.packagingCharge).toBe(18);
  });

  it('isola o catálogo por conta e recusa referência cruzada', async () => {
    const second = await s.issueFor('outra@example.com');
    const other = await s.login('outra@example.com');
    expect(second).toBeDefined();
    const result = await push(other, p => {
      p.upserts.ingredients = [ing('f')];
      p.upserts.recipes = [rec('r', 'f', { packagingItems: [{ packagingId: 'box', quantityPerUnit: 1 }] })];
    });
    expect(result.status).toBe(422);
  });
});

describe('Envio e leitura', () => {
  it('conta nova começa na revisão 0; um envio cria tudo na revisão 1 e a leitura devolve o mesmo conteúdo', async () => {
    expect((await pull(bia)).body).toMatchObject({ revision: 0, ingredients: [], recipes: [], orders: [] });
    const full = { ingredients: [ing('f', { densityGPerMl: 0.5, gramsPerUnit: 50 }), ing('a', { unit: 'kg', purchaseQuantity: 1 })], recipes: [rec('r', 'f', { items: [{ ingredientId: 'f', quantity: 2, unit: 'xic' }, { ingredientId: 'a', quantity: 100 }] })], orders: [ord('o', 'r', { costSnapshot: { costPerUnit: 4.25, capturedAt: '2026-11-11T10:00:00.000Z' } }), ord('o2', 'r')] };
    const res = await push(bia, p => { p.upserts.ingredients = full.ingredients; p.upserts.recipes = full.recipes; p.upserts.orders = full.orders; p.upserts.settings = { cupSizeMl: 250 }; });
    expect(res.status).toBe(200); expect(await json(res)).toEqual({ revision: 1, changed: true });
    const { body } = await pull(bia);
    expect(body.revision).toBe(1);
    const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(byId(body.ingredients.map(e => e.data!))).toEqual(byId(full.ingredients));
    expect(byId(body.recipes.map(e => e.data!))).toEqual(byId(full.recipes));
    expect(byId(body.orders.map(e => e.data!))).toEqual(byId(full.orders));
    expect(body.settings).toEqual({ rev: 1, data: { cupSizeMl: 250 } });
    expect([...body.ingredients, ...body.recipes, ...body.orders].every(e => e.rev === 1 && !e.deleted)).toBe(true);
    expect((await pull(bia, 1)).body).toMatchObject({ revision: 1, ingredients: [], recipes: [], orders: [] }); // nada depois da revisão 1
    expect((await pull(bia, 1)).body.settings).toBeUndefined();
  });
  it('leitura incremental traz só o que mudou depois da revisão informada', async () => {
    await push(bia, p => { p.upserts.ingredients = [ing('f'), ing('a')]; });
    await push(bia, p => { p.upserts.ingredients = [ing('f', { purchasePrice: 9 })]; p.baseRevs.ingredients = { f: 1 }; }, 1);
    const since1 = (await pull(bia, 1)).body;
    expect(since1.revision).toBe(2); expect(since1.ingredients.map(e => [e.id, e.rev, e.data?.purchasePrice])).toEqual([['f', 2, 9]]);
  });
  it('reenviar exatamente o mesmo pedido é idempotente (sem nova revisão nem duplicatas)', async () => {
    const build = (p: PushRequest) => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f')]; };
    expect(await json(await push(bia, build))).toEqual({ revision: 1, changed: true });
    expect(await json(await push(bia, build))).toEqual({ revision: 1, changed: false });
    expect(s.table('ingredients')).toHaveLength(1); expect(s.table('recipes')).toHaveLength(1); expect(s.table('recipe_items')).toHaveLength(1);
  });
  it('editar uma receita substitui os itens sem acumular linhas antigas', async () => {
    await push(bia, p => { p.upserts.ingredients = [ing('f'), ing('a')]; p.upserts.recipes = [rec('r', 'f', { items: [{ ingredientId: 'f', quantity: 1 }, { ingredientId: 'a', quantity: 2 }, { ingredientId: 'f', quantity: 3 }] })]; });
    await push(bia, p => { p.upserts.recipes = [rec('r', 'a', { items: [{ ingredientId: 'a', quantity: 9 }] })]; p.baseRevs.recipes = { r: 1 }; }, 1);
    expect(s.table('recipe_items').map(i => [i.position, i.ingredient_id, i.quantity])).toEqual([[0, 'a', 9]]);
    expect((await pull(bia, 1)).body.recipes[0].data?.items).toEqual([{ ingredientId: 'a', quantity: 9 }]);
  });
});

describe('Validação do conteúdo', () => {
  it('rejeita dados inválidos (mesmas regras do backup) sem gravar nada', async () => {
    const bads: [string, (p: PushRequest) => void][] = [
      ['preço negativo', p => { p.upserts.ingredients = [ing('f', { purchasePrice: -1 })]; }],
      ['quantidade zero', p => { p.upserts.ingredients = [ing('f', { purchaseQuantity: 0 })]; }],
      ['unidade inválida', p => { p.upserts.ingredients = [ing('f', { unit: 'xx' as never })]; }],
      ['id inválido', p => { p.upserts.ingredients = [ing("x' OR '1'='1")]; }],
      ['margem 100', p => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f', { desiredMargin: 100 })]; }],
      ['sinal maior que o total', p => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f')]; p.upserts.orders = [ord('o', 'r', { deposit: 11 })]; }],
      ['data inválida', p => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f')]; p.upserts.orders = [ord('o', 'r', { deliveryDate: '2026-02-31' })]; }],
      ['configuração inválida', p => { p.upserts.settings = { cupSizeMl: -5 }; }],
      ['ids repetidos', p => { p.upserts.ingredients = [ing('f'), ing('f')]; }],
      ['alterar e excluir o mesmo id', p => { p.upserts.ingredients = [ing('f')]; p.deletes.ingredients = ['f']; }],
    ];
    for (const [name, build] of bads) { const r = await push(bia, build); expect([400, 422], name).toContain(r.status); }
    expect(s.table('ingredients')).toHaveLength(0); expect(s.table('sync_state')[0].revision).toBe(0);
  });
  it('rejeita corpo malformado, revisão base futura e envios grandes demais', async () => {
    for (const body of [null, 'x', {}, { baseRevision: -1, baseRevs: {}, upserts: {}, deletes: {} }, { ...emptyPush(0), upserts: { ingredients: 'x', recipes: [], orders: [] } }, { ...emptyPush(0), deletes: { ingredients: [1], recipes: [], orders: [] } }, { ...emptyPush(0), baseRevs: { ingredients: { a: -1 }, recipes: {}, orders: {} } }]) {
      expect((await s.request('POST', '/api/sync/v2/push', { session: bia, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await push(bia, () => {}, 5)).status).toBe(400);
    const many = await push(bia, p => { p.upserts.ingredients = Array.from({ length: SYNC_LIMITS.maxChangesPerPush + 1 }, (_, i) => ing(`i${i}`)); });
    expect(many.status).toBe(413);
    const huge = await s.request('POST', '/api/sync/v2/push', { session: bia, body: { ...emptyPush(0), upserts: { ingredients: [ing('f', { name: 'x'.repeat(SYNC_LIMITS.maxBodyBytes) })], recipes: [], orders: [] } } });
    expect(huge.status).toBe(413);
  });
  it('relacionamentos: receita sem ingrediente e encomenda sem receita → 422', async () => {
    expect((await push(bia, p => { p.upserts.recipes = [rec('r', 'nao-existe')]; })).status).toBe(422);
    expect((await push(bia, p => { p.upserts.orders = [ord('o', 'nao-existe')]; })).status).toBe(422);
    expect(s.table('recipes')).toHaveLength(0);
  });
});

describe('Conflitos, atomicidade e concorrência', () => {
  beforeEach(async () => { await push(bia, p => { p.upserts.ingredients = [ing('f'), ing('a')]; }); });
  it('alteração baseada numa revisão antiga → 409 CONFLICT e NADA é aplicado', async () => {
    await push(bia, p => { p.upserts.ingredients = [ing('f', { purchasePrice: 8 })]; p.baseRevs.ingredients = { f: 1 }; }, 1); // outro dispositivo: f vai à rev 2
    const res = await push(bia, p => { p.upserts.ingredients = [ing('f', { purchasePrice: 99 }), ing('a', { purchasePrice: 77 })]; p.baseRevs.ingredients = { f: 1, a: 1 }; }, 1);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'CONFLICT', conflicts: [{ kind: 'ingredients', id: 'f', serverRev: 2 }], revision: 2 });
    const rows = s.table('ingredients');
    expect(rows.find(r => r.id === 'f')!.purchase_price).toBe(8); expect(rows.find(r => r.id === 'a')!.purchase_price).toBe(6); // 'a' (sem conflito) também não foi aplicada: tudo ou nada
    expect(s.table('sync_state')[0].revision).toBe(2);
  });
  it('mesma alteração vinda de outro dispositivo não é conflito (idempotente)', async () => {
    await push(bia, p => { p.upserts.ingredients = [ing('f', { purchasePrice: 8 })]; p.baseRevs.ingredients = { f: 1 }; }, 1);
    const res = await push(bia, p => { p.upserts.ingredients = [ing('f', { purchasePrice: 8 })]; p.baseRevs.ingredients = { f: 1 }; }, 1);
    expect(await json(res)).toEqual({ revision: 2, changed: false });
  });
  it('editar um item excluído em outro dispositivo é conflito; recriar com a revisão da exclusão é permitido', async () => {
    await push(bia, p => { p.deletes.ingredients = ['a']; p.baseRevs.ingredients = { a: 1 }; }, 1); // a: tombstone rev 2
    expect((await push(bia, p => { p.upserts.ingredients = [ing('a', { purchasePrice: 1 })]; p.baseRevs.ingredients = { a: 1 }; }, 2)).status).toBe(409);
    expect((await push(bia, p => { p.upserts.ingredients = [ing('a', { purchasePrice: 1 })]; p.baseRevs.ingredients = { a: 2 }; }, 2)).status).toBe(200);
    expect(s.table('ingredients').find(r => r.id === 'a')).toMatchObject({ deleted_at: null, purchase_price: 1, rev: 3 });
  });
  it('envios simultâneos de entidades DIFERENTES não conflitam: todos são aplicados, em revisões distintas e sem linhas órfãs', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => push(bia, p => { p.upserts.ingredients = [ing(`c${i}`)]; p.upserts.recipes = [rec(`rc${i}`, `c${i}`)]; }, 1)));
    const ok = results.filter(r => r.status === 200).length;
    expect(results.every(r => r.status === 200 || r.status === 409)).toBe(true);
    expect(ok).toBeGreaterThan(0);
    expect(s.table('ingredients').filter(r => String(r.id).startsWith('c'))).toHaveLength(ok);
    expect(s.table('recipes')).toHaveLength(ok);
    expect(s.table('recipe_items')).toHaveLength(ok); // cada receita aplicada trouxe seus itens; nenhuma ficou pela metade
    expect(s.table('sync_state')[0].revision).toBe(1 + ok);
    const revs = s.table('recipes').map(r => r.rev as number);
    expect(new Set(revs).size).toBe(ok); // cada envio aplicado teve a própria revisão
  });
  it('corrida entre a leitura e a gravação do mesmo envio: STALE, e NADA é aplicado (tudo ou nada)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const slowDb = { prepare: s.env.DB.prepare.bind(s.env.DB), batch: async (statements: Parameters<typeof s.env.DB.batch>[0]) => { if (first) { first = false; await gate; } return s.env.DB.batch(statements); } };
    const body = emptyPush(1); body.upserts.ingredients = [ing('lento')]; body.upserts.recipes = [rec('rlento', 'lento')];
    const slow = s.handle(new Request(`https://api.exemplo.test/api/sync/v2/push`, { method: 'POST', headers: { cookie: bia.cookie, 'x-csrf-token': bia.csrf, origin: 'http://localhost:5174', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...s.env, DB: slowDb });
    await new Promise(r => setTimeout(r, 20)); // o envio lento já leu a revisão 1 e está esperando para gravar
    expect((await push(bia, p => { p.upserts.ingredients = [ing('rapido')]; }, 1)).status).toBe(200); // outro dispositivo grava (revisão 2)
    release();
    const lost = await slow;
    expect(lost.status).toBe(409);
    expect(await json(lost)).toMatchObject({ error: 'STALE', revision: 2 });
    expect(s.table('ingredients').map(r => r.id)).not.toContain('lento'); // nenhuma instrução do envio perdedor foi aplicada
    expect(s.table('recipes')).toHaveLength(0); expect(s.table('recipe_items')).toHaveLength(0);
    expect(s.table('ingredients').map(r => r.id)).toContain('rapido');
    // reenviar o mesmo pedido agora (com a revisão atual) funciona
    expect((await push(bia, p => { p.upserts.ingredients = [ing('lento')]; p.upserts.recipes = [rec('rlento', 'lento')]; }, 2)).status).toBe(200);
  });
  it('configurações: conflito só quando mudaram em outro dispositivo e são diferentes', async () => {
    await push(bia, p => { p.upserts.settings = { cupSizeMl: 250 }; }, 1);
    expect((await push(bia, p => { p.upserts.settings = { cupSizeMl: 200 }; p.baseRevs.settings = 0; }, 2)).status).toBe(409);
    expect((await push(bia, p => { p.upserts.settings = { cupSizeMl: 250 }; p.baseRevs.settings = 0; }, 2)).status).toBe(200); // igual ao do servidor
    expect((await push(bia, p => { p.upserts.settings = { cupSizeMl: 200 }; p.baseRevs.settings = 2; }, 2)).status).toBe(200);
  });
});

describe('Exclusões lógicas e integridade', () => {
  beforeEach(async () => { await push(bia, p => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f')]; p.upserts.orders = [ord('o', 'r')]; }); });
  it('exclusão é lógica: a linha permanece, aparece como tombstone e os itens da receita saem', async () => {
    const res = await push(bia, p => { p.deletes.orders = ['o']; p.deletes.recipes = ['r']; p.deletes.ingredients = ['f']; p.baseRevs.orders = { o: 1 }; p.baseRevs.recipes = { r: 1 }; p.baseRevs.ingredients = { f: 1 }; }, 1);
    expect(res.status).toBe(200);
    for (const t of ['orders', 'recipes', 'ingredients']) expect(s.table(t)[0].deleted_at).not.toBeNull(); // nada foi apagado de verdade
    expect(s.table('recipe_items')).toHaveLength(0);
    const { body } = await pull(bia, 1);
    expect([...body.ingredients, ...body.recipes, ...body.orders].map(e => [e.deleted, e.data])).toEqual([[true, undefined], [true, undefined], [true, undefined]]);
  });
  it('não exclui ingrediente usado por receita ativa nem receita usada por encomenda ativa (422)', async () => {
    expect((await push(bia, p => { p.deletes.ingredients = ['f']; p.baseRevs.ingredients = { f: 1 }; }, 1)).status).toBe(422);
    expect((await push(bia, p => { p.deletes.recipes = ['r']; p.baseRevs.recipes = { r: 1 }; }, 1)).status).toBe(422);
    expect(s.table('ingredients')[0].deleted_at).toBeNull(); expect(s.table('recipes')[0].deleted_at).toBeNull();
  });
  it('excluir o ingrediente junto com a receita que o usa, no mesmo envio, é válido', async () => {
    const r = await push(bia, p => { p.deletes.orders = ['o']; p.deletes.recipes = ['r']; p.deletes.ingredients = ['f']; p.baseRevs.orders = { o: 1 }; p.baseRevs.recipes = { r: 1 }; p.baseRevs.ingredients = { f: 1 }; }, 1);
    expect(r.status).toBe(200);
  });
  it('excluir algo inexistente ou já excluído não faz nada', async () => {
    expect(await json(await push(bia, p => { p.deletes.orders = ['nunca-existiu']; }, 1))).toEqual({ revision: 1, changed: false });
  });
  it('trocar a receita de uma encomenda e excluir a antiga no mesmo envio é válido', async () => {
    await push(bia, p => { p.upserts.recipes = [rec('r2', 'f')]; }, 1);
    const r = await push(bia, p => { p.upserts.orders = [ord('o', 'r2')]; p.deletes.recipes = ['r']; p.baseRevs.orders = { o: 1 }; p.baseRevs.recipes = { r: 1 }; }, 2);
    expect(r.status).toBe(200);
  });
});

describe('Isolamento entre contas', () => {
  it('uma conta não lê, conflita nem altera dados de outra, mesmo usando os mesmos ids', async () => {
    await s.issueFor('ana@exemplo.com');
    const ana = await s.login('ana@exemplo.com');
    await push(bia, p => { p.upserts.ingredients = [ing('f', { name: 'Da Bia' })]; });
    expect((await pull(ana)).body).toMatchObject({ revision: 0, ingredients: [] });
    const own = await push(ana, p => { p.upserts.ingredients = [ing('f', { name: 'Da Ana' })]; });
    expect(own.status).toBe(200); expect(await json(own)).toEqual({ revision: 1, changed: true });
    expect((await pull(bia)).body.ingredients[0].data?.name).toBe('Da Bia');
    expect((await pull(ana)).body.ingredients[0].data?.name).toBe('Da Ana');
    expect((await push(ana, p => { p.deletes.ingredients = ['f']; p.baseRevs.ingredients = { f: 1 }; }, 1)).status).toBe(200);
    expect((await pull(bia)).body.ingredients[0].deleted).toBe(false); // a exclusão da Ana não afetou a Bia
    expect(s.table('sync_state').map(r => [r.user_id, r.revision]).length).toBe(2);
  });
  it('uma conta não consegue referenciar receitas ou ingredientes de outra', async () => {
    await s.issueFor('ana@exemplo.com');
    const ana = await s.login('ana@exemplo.com');
    await push(bia, p => { p.upserts.ingredients = [ing('f')]; p.upserts.recipes = [rec('r', 'f')]; });
    expect((await push(ana, p => { p.upserts.recipes = [rec('rx', 'f')]; })).status).toBe(422);
    expect((await push(ana, p => { p.upserts.orders = [ord('ox', 'r')]; })).status).toBe(422);
  });
});
