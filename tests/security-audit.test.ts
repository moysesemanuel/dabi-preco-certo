import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPush, type PushRequest } from '../shared/sync';
import { makeServer, type Server, type Session } from './helpers/server';

// Auditoria pré-beta: testes NEGATIVOS contra o Worker real (SQLite com as migrações reais). Nada aqui toca a rede.
let srv: Server, A: Session, B: Session;
beforeEach(async () => { srv = makeServer(); await srv.issueFor('ana@exemplo.com'); await srv.issueFor('bruno@exemplo.com'); A = await srv.login('ana@exemplo.com', 'A', '10.0.0.1'); B = await srv.login('bruno@exemplo.com', 'B', '10.0.0.2'); });

const ing = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Ing ${id}`, unit: 'g', purchaseQuantity: 1000, purchasePrice: 6, ...over });
const rec = (id: string, ingredientId: string) => ({ id, name: `Rec ${id}`, yield: 10, items: [{ ingredientId, quantity: 100, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 });
const ord = (id: string, recipeId: string, over: Record<string, unknown> = {}) => ({ id, customer: 'Cliente', recipeId, quantity: 2, unitPrice: 50, deposit: 10, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const push = (s: Session, patch: (p: PushRequest) => void, base = 0) => { const p = emptyPush(base); patch(p); return srv.request('POST', '/api/sync/push', { session: s, body: p }); };
const seedA = async () => { const r = await push(A, p => { p.upserts.ingredients.push(ing('i1') as never); p.upserts.recipes.push(rec('r1', 'i1') as never); p.upserts.orders.push(ord('o1', 'r1', { quoteCode: 'ORC-K7M42P', payments: [{ id: 'p1', amount: 20, receivedAt: '2026-11-12' }] }) as never); }); expect(r.status).toBe(200); };
const pull = async (s: Session, since = 0) => (await (await srv.request('GET', `/api/sync?since=${since}`, { session: s })).json()) as { revision: number; ingredients: { id: string; data?: { name: string } }[]; recipes: { id: string }[]; orders: { id: string; data?: { customer: string; payments?: { id: string }[]; quoteCode?: string } }[] };

describe('Isolamento entre clientes (o usuário vem da sessão, nunca do payload)', () => {
  it('B não enxerga nada de A, nem pedindo desde a revisão 0', async () => {
    await seedA(); const b = await pull(B); expect(b.ingredients).toEqual([]); expect(b.recipes).toEqual([]); expect(b.orders).toEqual([]);
  });
  it('B usa os MESMOS ids de A: cria linhas próprias e as de A ficam intactas', async () => {
    await seedA();
    expect((await push(B, p => { p.upserts.ingredients.push(ing('i1', { name: 'DO BRUNO' }) as never); p.upserts.recipes.push(rec('r1', 'i1') as never); p.upserts.orders.push(ord('o1', 'r1', { customer: 'BRUNO' }) as never); })).status).toBe(200);
    const a = await pull(A); expect(a.ingredients[0].data!.name).toBe('Ing i1'); expect(a.orders[0].data!.customer).toBe('Cliente'); expect(a.orders[0].data!.payments?.map(p => p.id)).toEqual(['p1']);
  });
  it('B forja revisões base, exclusões e ids de A: nada de A muda; as exclusões são ignoradas', async () => {
    await seedA(); const before = JSON.stringify(await pull(A));
    await push(B, p => { p.deletes.orders.push('o1'); p.deletes.recipes.push('r1'); p.deletes.ingredients.push('i1'); p.baseRevs.orders.o1 = 1; p.baseRevs.recipes.r1 = 1; p.baseRevs.ingredients.i1 = 1; });
    expect(JSON.stringify(await pull(A))).toBe(before);
  });
  it('B não referencia a receita nem o ingrediente de A (422), e a resposta não revela se o id existe em outra conta', async () => {
    await seedA();
    const r1 = await push(B, p => { p.upserts.orders.push(ord('ob', 'r1') as never); }); expect(r1.status).toBe(422);
    const r2 = await push(B, p => { p.upserts.recipes.push(rec('rb', 'i1') as never); }); expect(r2.status).toBe(422);
    const ghost = await push(B, p => { p.upserts.orders.push(ord('ob2', 'receita-que-nao-existe-em-lugar-nenhum') as never); });
    expect(await r1.text()).toBe(await ghost.text()); // a mesma mensagem para "de outra conta" e "inexistente"
  });
  it('o código permanente de A pode ser reutilizado por B sem erro nem pista (códigos são por conta e não são consultáveis)', async () => {
    await seedA(); await push(B, p => { p.upserts.ingredients.push(ing('x') as never); p.upserts.recipes.push(rec('rx', 'x') as never); });
    const res = await push(B, p => { p.upserts.orders.push(ord('ob', 'rx', { quoteCode: 'ORC-K7M42P' }) as never); }, 1); expect(res.status).toBe(200);
    for (const path of ['/o/ORC-K7M42P', '/api/quotes/ORC-K7M42P', '/api/orders/ORC-K7M42P']) expect([400, 401, 404]).toContain((await srv.request('GET', path, { session: B })).status);
  });
  it('configurações são por conta', async () => {
    await push(A, p => { p.upserts.settings = { cupSizeMl: 250, businessName: 'Doces da Ana' }; });
    const b = await (await srv.request('GET', '/api/sync?since=0', { session: B })).json() as { settings?: unknown }; expect(b.settings).toBeUndefined();
  });
  it('sessões: B não vê, não encerra e não reaproveita sessões de A; o CSRF de uma conta não vale na outra', async () => {
    const list = await (await srv.request('GET', '/api/sessions', { session: B })).json() as { sessions: { id: string }[] }; expect(list.sessions.map(s => s.id)).toEqual([B.sessionId]);
    expect((await srv.request('DELETE', `/api/sessions/${A.sessionId}`, { session: B })).status).toBe(404); expect((await srv.request('GET', '/api/auth/session', { session: A })).status).toBe(200);
    expect((await srv.request('POST', '/api/sync/push', { session: { ...A, csrf: B.csrf }, body: emptyPush(0) })).status).toBe(403);
  });
});

describe('Integridade financeira também no servidor (o front-end não é a única barreira)', () => {
  const withOrder = (over: Record<string, unknown>) => push(A, p => { p.upserts.ingredients.push(ing('i1') as never); p.upserts.recipes.push(rec('r1', 'i1') as never); p.upserts.orders.push(ord('o1', 'r1', over) as never); });
  const pay = (id: string, amount: unknown, receivedAt: unknown = '2026-11-12') => ({ id, amount, receivedAt });
  it.each([
    ['recebimento negativo', { payments: [pay('p', -5)] }], ['recebimento zero', { payments: [pay('p', 0)] }],
    ['recebimentos acima do total (sinal + recebimentos > 100)', { deposit: 50, payments: [pay('p', 30), pay('q', 30)] }], ['um recebimento maior que o total', { payments: [pay('p', 100.01)] }],
    ['sinal maior que o total', { deposit: 100.01 }], ['sinal negativo', { deposit: -1 }], ['identificador de recebimento repetido', { payments: [pay('p', 10), pay('p', 10)] }],
    ['data de recebimento inválida', { payments: [pay('p', 10, '2026-13-45')] }], ['valor como texto', { payments: [pay('p', '10')] }], ['valor infinito', { payments: [pay('p', Infinity)] }],
    ['mais de 100 recebimentos', { payments: Array.from({ length: 101 }, (_, i) => pay(`p${i}`, 0.01)) }],
    ['quantidade zero', { quantity: 0 }], ['quantidade negativa', { quantity: -1 }], ['preço negativo', { unitPrice: -1 }], ['custo registrado negativo', { costSnapshot: { costPerUnit: -1, capturedAt: '2026-11-11T10:00:00.000Z' } }],
    ['status inválido', { status: 'Cancelado' }], ['id com caracteres perigosos', { id: "o1'; DROP TABLE orders;--" }],
  ])('recusa: %s (400) e não grava nada', async (_n, over) => {
    const res = await withOrder(over); expect(res.status).toBe(400); expect(srv.table('orders')).toHaveLength(0); expect(srv.table('order_payments')).toHaveLength(0);
  });
  it('JSON com número fora da faixa (1e999) é recusado', async () => {
    const body = JSON.stringify({ ...emptyPush(0), upserts: { ingredients: [], recipes: [], orders: [] } }).replace('"orders":[]', '"orders":[{"id":"o","customer":"x","recipeId":"r","quantity":1e999,"unitPrice":1,"deposit":0,"deliveryDate":"2026-12-01","status":"Confirmado","createdAt":"2026-11-11T10:00:00.000Z"}]');
    const res = await srv.handle(new Request('https://api.exemplo.test/api/sync/push', { method: 'POST', body, headers: { cookie: A.cookie, 'x-csrf-token': A.csrf, origin: 'http://localhost:5174', 'content-type': 'application/json' } }), srv.env); expect([400, 422]).toContain(res.status);
  });
  it('reenvio idêntico e envios SIMULTÂNEOS do mesmo recebimento: uma só linha de recebimento, nunca duplicada', async () => {
    await seedA(); const send = () => push(A, p => { p.upserts.orders.push(ord('o1', 'r1', { payments: [pay('p1', 20), pay('p2', 15)] }) as never); p.baseRevs.orders.o1 = 1; }, 1);
    const results = await Promise.all([send(), send(), send()]); expect(results.some(r => r.status === 200)).toBe(true);
    for (let i = 0; i < 3; i++) await send();
    expect(srv.table('order_payments').map(r => r.id).sort()).toEqual(['p1', 'p2']); // nunca p1/p2 repetidos
  });
  it('alterar o sinal ou os recebimentos de um pedido não mexe no custo registrado (snapshot) nem no código', async () => {
    await push(A, p => { p.upserts.ingredients.push(ing('i1') as never); p.upserts.recipes.push(rec('r1', 'i1') as never); p.upserts.orders.push(ord('o1', 'r1', { quoteCode: 'ORC-K7M42P', costSnapshot: { costPerUnit: 3.5, capturedAt: '2026-11-11T10:00:00.000Z' } }) as never); });
    await push(A, p => { p.upserts.orders.push(ord('o1', 'r1', { deposit: 30, payments: [pay('p1', 10)], costSnapshot: { costPerUnit: 3.5, capturedAt: '2026-11-11T10:00:00.000Z' } }) as never); p.baseRevs.orders.o1 = 1; }, 1);
    const row = srv.table('orders')[0]; expect([row.cost_per_unit, row.cost_captured_at, row.quote_code]).toEqual([3.5, '2026-11-11T10:00:00.000Z', 'ORC-K7M42P']);
  });
});

describe('API: limites, métodos, CORS e vazamento de informação', () => {
  const raw = (method: string, path: string, over: { body?: string; origin?: string; s?: Session | null } = {}) => srv.handle(new Request(`https://api.exemplo.test${path}`, { method, body: over.body, headers: { 'content-type': 'application/json', origin: over.origin ?? 'http://localhost:5174', ...(over.s === null ? {} : { cookie: (over.s ?? A).cookie, 'x-csrf-token': (over.s ?? A).csrf }) } }), srv.env);
  it('corpo gigante é recusado (413) antes de gravar', async () => { expect((await raw('POST', '/api/sync/push', { body: JSON.stringify({ x: 'a'.repeat(3_000_000) }) })).status).toBe(413); });
  it('JSON inválido: 400 sem detalhes internos', async () => { const r = await raw('POST', '/api/sync/push', { body: '{nao-json' }); expect(r.status).toBe(400); expect(await r.text()).not.toMatch(/SyntaxError|at |node:|\.ts/); });
  it('rotas protegidas sem sessão: 401', async () => { for (const [m, p] of [['GET', '/api/sync?since=0'], ['POST', '/api/sync/push'], ['GET', '/api/sessions'], ['GET', '/api/quotes']]) expect((await raw(m, p, { s: null, body: m === 'POST' ? '{}' : undefined })).status).toBe(401); });
  it('métodos não previstos não são aceitos', async () => { for (const m of ['PUT', 'PATCH', 'DELETE']) expect([404, 405]).toContain((await raw(m, '/api/sync/push', { body: '{}' })).status); });
  it('origem não permitida: sem cabeçalhos CORS e sem efeito (403)', async () => {
    const r = await raw('POST', '/api/sync/push', { body: JSON.stringify(emptyPush(0)), origin: 'https://evil.example' });
    expect(r.status).toBe(403); expect(r.headers.get('access-control-allow-origin')).toBeNull(); expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it("texto com SQL/HTML no conteúdo é gravado como texto, sem executar nada", async () => {
    const evil = "x'); DROP TABLE users;-- <script>alert(1)</script>";
    expect((await push(A, p => { p.upserts.ingredients.push(ing('i9', { name: evil }) as never); })).status).toBe(200);
    expect(srv.table('users').length).toBeGreaterThan(0); expect((await pull(A)).ingredients.find(i => i.id === 'i9')!.data!.name).toBe(evil);
  });
});
