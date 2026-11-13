import { beforeEach, describe, expect, it } from 'vitest';
import worker, { createHandler, type Authorizer, type Env } from '../worker/src/index';
import { ID_PATTERN, generateId, insertQuote } from '../worker/src/store';
import type { PublicQuote } from '../shared/publicQuote';
import { createTestD1 } from './helpers/d1';

const BASE = 'https://orcamento.exemplo.test';
const quote = (over: Partial<PublicQuote> = {}): PublicQuote => ({
  version: 1, quoteNumber: '001', businessName: 'Doces da Bia', businessPhone: '5541999990000', issuedAt: '2026-11-11', validUntil: '2026-11-15',
  items: [{ description: 'Bolo de chocolate', quantity: 2, unitPriceCents: 6500 }], deliveryFeeCents: 1500, notes: 'Reserva sujeita à confirmação', ...over,
});
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const NOW = new Date('2026-11-12T15:00:00Z');

let db: ReturnType<typeof createTestD1>;
let env: Env;
beforeEach(() => { db = createTestD1(); env = { DB: db.d1, PUBLIC_BASE_URL: BASE }; });

const seed = (id: string, q: PublicQuote, ownerId = 'dono-1') => insertQuote(db.d1, { id, payload: JSON.stringify(q), now: NOW.toISOString(), ownerId });
const as = (ownerId: string | null): Authorizer => async () => (ownerId ? { ok: true, ownerId } : { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Chave de licença ausente ou inválida.' });
const handler = (ownerId: string | null = 'dono-1', ids: string[] = []) => createHandler({ authorize: as(ownerId), now: () => NOW, newId: () => ids.shift() ?? generateId() });
const req = (method: string, path: string, body?: unknown) => new Request(`${BASE}${path}`, { method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
const readOnly = createHandler({ authorize: as(null), now: () => NOW });

describe('Leitura pública', () => {
  it('exibe o orçamento em HTML sem depender de dados locais', async () => {
    await seed(ID_A, quote());
    const res = await readOnly(req('GET', `/o/${ID_A}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const page = await res.text();
    for (const text of ['Doces da Bia', 'ORÇAMENTO Nº 001', 'Emitido em: 11/11/2026', 'Válido até: 15/11/2026', '2 × Bolo de chocolate', 'Valor unitário: R$ 65,00', 'Subtotal: R$ 130,00', 'Entrega', 'R$ 15,00', 'TOTAL', 'R$ 145,00', 'Reserva sujeita à confirmação', 'Falar pelo WhatsApp', 'src="/brand/custo-color.svg"', 'Orçamento criado com Custô']) expect(page, text).toContain(text);
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self'");
    expect(page).toContain('https://wa.me/5541999990000?text=');
    expect(page).not.toContain('Validade encerrada');
  });
  it('sem telefone válido não há botão de WhatsApp', async () => {
    await seed(ID_A, quote({ businessPhone: undefined }));
    const page = await (await readOnly(req('GET', `/o/${ID_A}`), env)).text();
    expect(page).not.toContain('wa.me'); expect(page).not.toContain('Falar pelo WhatsApp');
  });
  it('escapa todo texto do orçamento: nada vira HTML ou script', async () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    await seed(ID_A, quote({ businessName: evil, notes: `${evil}\n"aspas" & 'apóstrofo'`, items: [{ description: evil, quantity: 1, unitPriceCents: 100 }] }));
    const page = await (await readOnly(req('GET', `/o/${ID_A}`), env)).text();
    expect(page).not.toContain('<script'); expect(page).not.toContain('<img src=x'); expect(page).not.toContain('onerror=alert(2)>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('&quot;aspas&quot; &amp; &#39;apóstrofo&#39;');
  });
  it('sinaliza validade encerrada (data de hoje no Brasil), sem esconder o orçamento', async () => {
    await seed(ID_A, quote({ validUntil: '2026-11-11' }));
    const page = await (await readOnly(req('GET', `/o/${ID_A}`), env)).text();
    expect(page).toContain('Validade encerrada'); expect(page).toContain('R$ 145,00');
    const hoje = createHandler({ authorize: as(null), now: () => new Date('2026-11-12T01:00:00Z') }); // 22h de 11/11 no Brasil
    expect(await (await hoje(req('GET', `/o/${ID_A}`), env)).text()).not.toContain('Validade encerrada');
  });
  it('envia cabeçalhos de segurança e privacidade', async () => {
    await seed(ID_A, quote());
    const res = await readOnly(req('GET', `/o/${ID_A}`), env);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).not.toContain('script-src');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.clone().text()).not.toContain('<script');
  });
  it('HEAD não devolve corpo', async () => {
    await seed(ID_A, quote());
    const res = await readOnly(req('HEAD', `/o/${ID_A}`), env);
    expect(res.status).toBe(200); expect(await res.text()).toBe('');
  });
  it('id inexistente, malformado ou tentativa de injeção → 404 sem consultar nada perigoso', async () => {
    for (const id of [ID_B, 'curto', "x' OR '1'='1", '../../etc/passwd', 'A'.repeat(23), '%3Cscript%3E']) {
      const res = await readOnly(req('GET', `/o/${id}`), env);
      expect(res.status, id).toBe(404);
      expect(await res.text()).not.toContain('<script');
    }
    expect((await readOnly(req('GET', `/api/quotes/${ID_B}`), env)).status).toBe(404);
  });
  it('orçamento revogado → 410; dado corrompido nunca é exibido', async () => {
    await seed(ID_A, quote());
    await handler()(req('DELETE', `/api/quotes/${ID_A}`), env);
    expect((await readOnly(req('GET', `/o/${ID_A}`), env)).status).toBe(410);
    expect((await readOnly(req('GET', `/api/quotes/${ID_A}`), env)).status).toBe(410);
    await insertQuote(db.d1, { id: ID_B, payload: '{"version":1,"custo":10}', now: NOW.toISOString(), ownerId: 'x' });
    const res = await readOnly(req('GET', `/o/${ID_B}`), env);
    expect(res.status).toBe(500); expect(await res.text()).not.toContain('&quot;custo&quot;:10');
  });
  it('API JSON devolve só o orçamento público e os totais calculados, sem dados internos', async () => {
    await seed(ID_A, quote());
    const body = await (await readOnly(req('GET', `/api/quotes/${ID_A}`), env)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: ID_A, status: 'active', totals: { subtotalCents: 13000, deliveryFeeCents: 1500, discountCents: 0, totalCents: 14500 } });
    const text = JSON.stringify(body);
    for (const secret of ['owner', 'dono-1', 'payload', 'created_at', 'revoked']) expect(text).not.toContain(secret);
    expect(Object.keys(body).sort()).toEqual(['id', 'quote', 'status', 'totals', 'updatedAt']);
  });
  it('rotas desconhecidas e métodos não permitidos', async () => {
    expect((await readOnly(req('GET', '/'), env)).status).toBe(404);
    expect((await readOnly(req('GET', '/admin'), env)).status).toBe(404);
    expect((await readOnly(req('POST', `/o/${ID_A}`, {}), env)).status).toBe(405);
    expect((await readOnly(req('GET', '/api/quotes'), env)).status).toBe(401); // a listagem dos próprios links exige autenticação
    expect((await readOnly(req('PUT', '/api/quotes'), env)).status).toBe(405);
    expect((await readOnly(req('GET', '/healthz'), env)).status).toBe(200);
  });
});

describe('Escrita sem licença: o Worker exportado recusa tudo', () => {
  const attempts: [string, string, unknown][] = [['POST', '/api/quotes', quote()], ['PUT', `/api/quotes/${ID_A}`, quote()], ['DELETE', `/api/quotes/${ID_A}`, undefined]];
  it('o Worker exportado nega TODA escrita sem licença (401) e não grava nada', async () => {
    await seed(ID_A, quote());
    const before = db.rows();
    for (const [method, path, body] of attempts) {
      const res = await worker.fetch(req(method, path, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
    }
    expect(db.rows()).toEqual(before);
  });
  it('nem corpo gigante ou inválido é processado sem autorização', async () => {
    const res = await worker.fetch(req('POST', '/api/quotes', 'x'.repeat(100_000)), env);
    expect(res.status).toBe(401); expect(db.rows()).toHaveLength(0);
  });
  it('cabeçalhos de credencial inventados não liberam nada', async () => {
    const r = new Request(`${BASE}/api/quotes`, { method: 'POST', headers: { authorization: 'Bearer qualquer', 'x-api-key': 'admin', 'content-type': 'application/json' }, body: JSON.stringify(quote()) });
    expect((await worker.fetch(r, env)).status).toBe(401); expect(db.rows()).toHaveLength(0);
  });
  it('o Worker exportado ainda serve a leitura pública', async () => {
    await seed(ID_A, quote());
    expect((await worker.fetch(req('GET', `/o/${ID_A}`), env)).status).toBe(200);
  });
});

describe('Endpoints de escrita (prontos, atrás de autorizador injetado)', () => {
  it('cria um orçamento com id aleatório, devolve o link curto e guarda só o payload público', async () => {
    const res = await handler('dono-1', [ID_A])(req('POST', '/api/quotes', quote()), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ID_A, path: `/o/${ID_A}`, url: `${BASE}/o/${ID_A}` });
    const [row] = db.rows();
    expect(row).toMatchObject({ id: ID_A, owner_id: 'dono-1', revoked_at: null });
    expect(JSON.parse(row.payload as string)).toEqual(quote());
  });
  it('o link devolvido não contém dados do orçamento', async () => {
    const res = await handler()(req('POST', '/api/quotes', quote({ businessName: 'Segredo Doces' })), env);
    const { url } = await res.json() as { url: string };
    expect(url).toMatch(new RegExp(`^${BASE}/o/[A-Za-z0-9_-]{22}$`));
    expect(url).not.toContain('Segredo');
  });
  it('rejeita payload inválido, campos extras (custo/margem) e JSON quebrado', async () => {
    const h = handler();
    expect(await (await h(req('POST', '/api/quotes', { ...quote(), margin: 30 }), env)).json()).toMatchObject({ error: 'INVALID_QUOTE', code: 'UNKNOWN_FIELD', field: 'margin' });
    expect((await h(req('POST', '/api/quotes', quote({ items: [] })), env)).status).toBe(400);
    expect((await h(req('POST', '/api/quotes', '{quebrado'), env)).status).toBe(400);
    expect((await h(req('POST', '/api/quotes', 'null'), env)).status).toBe(400);
    expect(db.rows()).toHaveLength(0);
  });
  it('rejeita corpo acima do limite (413), por Content-Length e pelo tamanho real', async () => {
    const h = handler();
    const big = JSON.stringify(quote({ notes: 'x'.repeat(40_000) }));
    expect((await h(req('POST', '/api/quotes', big), env)).status).toBe(413);
    const lying = new Request(`${BASE}/api/quotes`, { method: 'POST', body: big, headers: { 'content-length': '10' } });
    expect((await h(lying, env)).status).toBe(413);
    expect(db.rows()).toHaveLength(0);
  });
  it('só o dono atualiza; outro comprador recebe 404 como se não existisse', async () => {
    await seed(ID_A, quote(), 'dono-1');
    const novo = quote({ items: [{ description: 'Bolo de chocolate', quantity: 3, unitPriceCents: 6500 }] });
    expect((await handler('dono-2')(req('PUT', `/api/quotes/${ID_A}`, novo), env)).status).toBe(404);
    expect(JSON.parse(db.rows()[0].payload as string).items[0].quantity).toBe(2);
    expect((await handler('dono-1')(req('PUT', `/api/quotes/${ID_A}`, novo), env)).status).toBe(200);
    expect(JSON.parse(db.rows()[0].payload as string).items[0].quantity).toBe(3);
    expect((await handler('dono-1')(req('PUT', `/api/quotes/${ID_A}`, { ...novo, cost: 1 }), env)).status).toBe(400);
    expect((await handler('dono-1')(req('PUT', `/api/quotes/inexistente`, novo), env)).status).toBe(404);
  });
  it('só o dono revoga; revogar é idempotente e bloqueia novas alterações', async () => {
    await seed(ID_A, quote(), 'dono-1');
    expect((await handler('dono-2')(req('DELETE', `/api/quotes/${ID_A}`), env)).status).toBe(404);
    expect(db.rows()[0].revoked_at).toBeNull();
    expect((await handler('dono-1')(req('DELETE', `/api/quotes/${ID_A}`), env)).status).toBe(200);
    const stamp = db.rows()[0].revoked_at;
    expect(stamp).toBe(NOW.toISOString());
    expect((await handler('dono-1')(req('DELETE', `/api/quotes/${ID_A}`), env)).status).toBe(200);
    expect(db.rows()[0].revoked_at).toBe(stamp);
    expect((await handler('dono-1')(req('PUT', `/api/quotes/${ID_A}`, quote()), env)).status).toBe(410);
  });
  it('autorizador que nega → 401, mesmo com payload válido', async () => {
    expect((await handler(null)(req('POST', '/api/quotes', quote()), env)).status).toBe(401);
    expect(db.rows()).toHaveLength(0);
  });
});

describe('Identificadores', () => {
  it('são aleatórios, com 128 bits em base64url (22 caracteres)', () => {
    const ids = new Set(Array.from({ length: 500 }, generateId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });
});
