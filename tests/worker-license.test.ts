import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLicenseAuthorizer } from '../worker/src/auth';
import worker, { createHandler, type Env } from '../worker/src/index';
import { issueLicenseSql, licenseStatusSql, listLicensesSql, revokeLicenseQuotesSql, setLicenseStatusSql } from '../worker/src/licenseAdmin';
import { generateLicenseId, generateLicenseKey, hashLicenseKey, KEY_HASH_PATTERN, LICENSE_ID_PATTERN } from '../worker/src/licenses';
import { insertQuote } from '../worker/src/store';
import { LICENSE_KEY_PATTERN, parseBearer } from '../shared/licenseKey';
import type { PublicQuote } from '../shared/publicQuote';
import { createTestD1 } from './helpers/d1';

const BASE = 'https://orcamento.exemplo.test';
const quote = (): PublicQuote => ({ version: 1, quoteNumber: '001', businessName: 'Doces da Bia', issuedAt: '2026-11-11', items: [{ description: 'Bolo', quantity: 1, unitPriceCents: 5000 }] });
const NOW = new Date('2026-11-12T15:00:00Z');

let db: ReturnType<typeof createTestD1>;
let env: Env;
let clock: Date;
beforeEach(() => { db = createTestD1(); env = { DB: db.d1, PUBLIC_BASE_URL: BASE, ALLOWED_ORIGINS: 'http://localhost:5174' }; clock = new Date(NOW); });
afterEach(() => vi.restoreAllMocks());

const makeHandler = (authOpts: { writesPerMinute?: number; verifyPerMinute?: number } = {}) => createHandler({ authorize: createLicenseAuthorizer(authOpts), now: () => clock });
const handle = makeHandler({ writesPerMinute: 1000, verifyPerMinute: 1000 });

async function issue(over: { quotaActive?: number; quotaDaily?: number; label?: string } = {}) {
  const key = generateLicenseKey();
  const id = generateLicenseId();
  db.raw.exec(issueLicenseSql({ id, keyHash: await hashLicenseKey(key), label: over.label, quotaActive: over.quotaActive ?? 100, quotaDaily: over.quotaDaily ?? 30, now: NOW.toISOString() }));
  return { key, id };
}
const call = (method: string, path: string, key: string | null, body?: unknown, h: ReturnType<typeof createHandler> = handle, extra: Record<string, string> = {}) =>
  h(new Request(`${BASE}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
const create = (key: string, h = handle) => call('POST', '/api/quotes', key, quote(), h);
const quoteCount = () => db.rows().length;
const everything = () => JSON.stringify([db.raw.prepare('SELECT * FROM licenses').all(), db.raw.prepare('SELECT * FROM quotes').all(), db.raw.prepare('SELECT * FROM rate_limits').all()]);
const dumpResponse = async (r: Response) => `${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await r.clone().text()}`;

describe('Chave e verificador', () => {
  it('gera chaves de 192 bits, únicas, com formato fixo, e identificadores internos separados', () => {
    const keys = new Set(Array.from({ length: 500 }, generateLicenseKey));
    expect(keys.size).toBe(500);
    for (const k of keys) { expect(k).toMatch(LICENSE_KEY_PATTERN); expect(k).toHaveLength(41); }
    expect(generateLicenseId()).toMatch(LICENSE_ID_PATTERN);
  });
  it('o verificador é o SHA-256 em hex (64 caracteres) e não revela a chave', async () => {
    const key = generateLicenseKey();
    const hash = await hashLicenseKey(key);
    expect(hash).toMatch(KEY_HASH_PATTERN); expect(hash).not.toContain(key.slice(9, 20));
    expect(await hashLicenseKey(key)).toBe(hash);
    const fixed = 'dabi_lic_' + 'A'.repeat(32);
    expect(await hashLicenseKey(fixed)).toBe(createHash('sha256').update(fixed).digest('hex')); // implementação independente (node:crypto)
  });
  it('parseBearer exige o esquema Bearer e o formato exato da chave', () => {
    const key = generateLicenseKey();
    expect(parseBearer(`Bearer ${key}`)).toBe(key); expect(parseBearer(`bearer ${key}`)).toBe(key);
    for (const bad of [null, undefined, '', 'Bearer', `Basic ${key}`, `Bearer ${key} extra`, `Bearer ${key.slice(0, -1)}`, `Bearer ${key}x`, key, 'Bearer dabi_lic_<script>']) expect(parseBearer(bad as string), String(bad)).toBeUndefined();
  });
});

describe('Autorização por licença', () => {
  it('licença válida publica; o dono fica registrado e a chave não é gravada', async () => {
    const { key, id } = await issue();
    const res = await create(key);
    expect(res.status).toBe(201);
    expect(db.rows()[0].owner_id).toBe(id);
    expect(everything()).not.toContain(key);
    expect(everything()).toContain(await hashLicenseKey(key));
  });
  it('licença inexistente → 401, sem gravar nada', async () => {
    await issue();
    const res = await create(generateLicenseKey());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(quoteCount()).toBe(0);
  });
  it('licença revogada → 403 e não publica; reativada volta a funcionar', async () => {
    const { key, id } = await issue();
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    const res = await create(key);
    expect(res.status).toBe(403); expect(await res.json()).toMatchObject({ error: 'LICENSE_REVOKED' });
    expect(quoteCount()).toBe(0);
    db.raw.exec(setLicenseStatusSql(id, 'active', NOW.toISOString()));
    expect((await create(key)).status).toBe(201);
  });
  it('cabeçalho ausente ou malformado → 401', async () => {
    const { key } = await issue();
    const headers = ['', 'Bearer', 'Bearer ', `Basic ${key}`, `Bearer ${key} extra`, `Bearer ${key.slice(0, -1)}`, `Bearer ${key}x`, key, `Token ${key}`, 'Bearer dabi_lic_curta', `Bearer ${key.toLowerCase()}`];
    for (const authorization of headers) {
      const res = await handle(new Request(`${BASE}/api/quotes`, { method: 'POST', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' }, body: JSON.stringify(quote()) }), env);
      expect(res.status, authorization).toBe(401);
    }
    expect((await call('POST', '/api/quotes', null, quote())).status).toBe(401);
    expect(quoteCount()).toBe(0);
  });
  it('aceita o esquema "bearer" em minúsculas', async () => {
    const { key } = await issue();
    const res = await handle(new Request(`${BASE}/api/quotes`, { method: 'POST', headers: { authorization: `bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(quote()) }), env);
    expect(res.status).toBe(201);
  });
  it('a chave na URL nunca autentica', async () => {
    const { key } = await issue();
    for (const path of [`/api/quotes?key=${key}`, `/api/quotes?access_token=${key}`, `/api/quotes?authorization=Bearer%20${key}`]) {
      expect((await call('POST', path, null, quote())).status, path).toBe(401);
    }
    expect((await call('GET', `/api/license?key=${key}`, null)).status).toBe(401);
    expect(quoteCount()).toBe(0);
  });
  it('um comprador não atualiza nem revoga orçamentos de outro', async () => {
    const a = await issue(), b = await issue();
    const { id } = await (await create(a.key)).json() as { id: string };
    const changed = { ...quote(), businessName: 'Invasor' };
    expect((await call('PUT', `/api/quotes/${id}`, b.key, changed)).status).toBe(404);
    expect((await call('DELETE', `/api/quotes/${id}`, b.key)).status).toBe(404);
    expect(JSON.parse(db.rows()[0].payload as string).businessName).toBe('Doces da Bia');
    expect(db.rows()[0].revoked_at).toBeNull();
    expect((await call('PUT', `/api/quotes/${id}`, a.key, { ...quote(), businessName: 'Doces da Bia 2' })).status).toBe(200);
    expect((await call('DELETE', `/api/quotes/${id}`, a.key)).status).toBe(200);
  });
  it('licença revogada não altera os próprios orçamentos, mas a leitura pública continua', async () => {
    const { key, id } = await issue();
    const { id: quoteId } = await (await create(key)).json() as { id: string };
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    expect((await call('PUT', `/api/quotes/${quoteId}`, key, quote())).status).toBe(403);
    expect((await call('DELETE', `/api/quotes/${quoteId}`, key)).status).toBe(403);
    expect((await call('GET', `/o/${quoteId}`, null)).status).toBe(200);
  });
  it('a leitura pública não exige autenticação e ignora credenciais inválidas', async () => {
    await insertQuote(db.d1, { id: 'AAAAAAAAAAAAAAAAAAAAAA', payload: JSON.stringify(quote()), now: NOW.toISOString(), ownerId: 'x' });
    for (const key of [null, 'lixo', generateLicenseKey()]) {
      expect((await call('GET', '/o/AAAAAAAAAAAAAAAAAAAAAA', key)).status).toBe(200);
      expect((await call('GET', '/api/quotes/AAAAAAAAAAAAAAAAAAAAAA', key)).status).toBe(200);
    }
    expect((await worker.fetch(new Request(`${BASE}/o/AAAAAAAAAAAAAAAAAAAAAA`), env)).status).toBe(200);
  });
  it('no Worker exportado a chave antiga vem DESLIGADA por padrão e só vale com LEGACY_KEY_AUTH=on', async () => {
    const { key } = await issue();
    const post = () => new Request(`${BASE}/api/quotes`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(quote()) });
    expect((await worker.fetch(new Request(`${BASE}/api/quotes`, { method: 'POST', body: JSON.stringify(quote()) }), env)).status).toBe(401);
    expect((await worker.fetch(post(), env)).status).toBe(401); // padrão: desligada
    expect((await worker.fetch(post(), { ...env, LEGACY_KEY_AUTH: 'off' })).status).toBe(401);
    expect((await worker.fetch(post(), { ...env, LEGACY_KEY_AUTH: 'on' })).status).toBe(201);
    expect(quoteCount()).toBe(1);
  });
});

describe('Verificação de licença (GET /api/license)', () => {
  it('licença ativa: informa status e uso das cotas', async () => {
    const { key, id } = await issue({ quotaActive: 5, quotaDaily: 3 });
    await create(key);
    const res = await call('GET', '/api/license', key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'active', licenseId: id, quotas: { active: { used: 1, limit: 5 }, daily: { used: 1, limit: 3 } } });
  });
  it('inválida → 401; revogada → 403; método errado → 405', async () => {
    const { key, id } = await issue();
    expect((await call('GET', '/api/license', generateLicenseKey())).status).toBe(401);
    expect((await call('GET', '/api/license', null)).status).toBe(401);
    expect((await call('POST', '/api/license', key, {})).status).toBe(405);
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    expect((await call('GET', '/api/license', key)).status).toBe(403);
  });
});

describe('Cotas de publicação', () => {
  it('limite de orçamentos ativos: bloqueia, informa uso e libera ao revogar um', async () => {
    const { key } = await issue({ quotaActive: 2 });
    const first = await (await create(key)).json() as { id: string };
    expect((await create(key)).status).toBe(201);
    const denied = await create(key);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ error: 'QUOTA_ACTIVE_EXCEEDED', used: 2, limit: 2 });
    expect(quoteCount()).toBe(2);
    await call('DELETE', `/api/quotes/${first.id}`, key);
    expect((await create(key)).status).toBe(201);
  });
  it('limite diário: revogar não devolve a cota do dia; no dia seguinte (fuso do Brasil) libera', async () => {
    const { key } = await issue({ quotaDaily: 2 });
    const a = await (await create(key)).json() as { id: string };
    await create(key);
    const denied = await create(key);
    expect(denied.status).toBe(429); expect(await denied.json()).toMatchObject({ error: 'QUOTA_DAILY_EXCEEDED', used: 2, limit: 2 });
    await call('DELETE', `/api/quotes/${a.id}`, key);
    expect((await create(key)).status).toBe(429);
    clock = new Date('2026-11-13T02:59:00Z'); // ainda é 12/11 no Brasil
    expect((await create(key)).status).toBe(429);
    clock = new Date('2026-11-13T03:00:00Z'); // 13/11 no Brasil
    expect((await create(key)).status).toBe(201);
  });
  it('as cotas são independentes por licença', async () => {
    const a = await issue({ quotaActive: 1 }), b = await issue({ quotaActive: 1 });
    expect((await create(a.key)).status).toBe(201); expect((await create(a.key)).status).toBe(429);
    expect((await create(b.key)).status).toBe(201);
  });
  it('cota zero bloqueia a criação', async () => {
    const { key } = await issue({ quotaActive: 0 });
    expect((await create(key)).status).toBe(429); expect(quoteCount()).toBe(0);
  });
  it('concorrência: criações simultâneas nunca ultrapassam a cota de ativos', async () => {
    const { key } = await issue({ quotaActive: 3, quotaDaily: 100 });
    const results = await Promise.all(Array.from({ length: 12 }, () => create(key)));
    expect(results.filter(r => r.status === 201)).toHaveLength(3);
    expect(results.filter(r => r.status === 429)).toHaveLength(9);
    expect(quoteCount()).toBe(3);
  });
  it('concorrência: criações simultâneas nunca ultrapassam a cota diária', async () => {
    const { key } = await issue({ quotaActive: 100, quotaDaily: 4 });
    const results = await Promise.all(Array.from({ length: 10 }, () => create(key)));
    expect(results.filter(r => r.status === 201)).toHaveLength(4);
    expect(quoteCount()).toBe(4);
  });
});

describe('Limitação de taxa', () => {
  it('bloqueia a partir do limite, com 429 e Retry-After, e libera na janela seguinte', async () => {
    const { key } = await issue();
    const h = makeHandler({ writesPerMinute: 5 });
    for (let i = 0; i < 5; i++) expect((await create(key, h)).status).toBe(201);
    const limited = await create(key, h);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(quoteCount()).toBe(5);
    clock = new Date(NOW.getTime() + 60_000);
    expect((await create(key, h)).status).toBe(201);
  });
  it('Retry-After mostra o tempo que falta na janela', async () => {
    const { key } = await issue();
    const h = makeHandler({ writesPerMinute: 1 });
    clock = new Date('2026-11-12T15:00:45Z');
    await create(key, h);
    expect((await create(key, h)).headers.get('retry-after')).toBe('15');
  });
  it('requisições inválidas também consomem o limite (e não gravam nada)', async () => {
    const { key } = await issue();
    const h = makeHandler({ writesPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await call('POST', '/api/quotes', key, { version: 1 }, h)).status).toBe(400);
    expect((await call('POST', '/api/quotes', key, quote(), h)).status).toBe(429);
    expect(quoteCount()).toBe(0);
  });
  it('atualizar e revogar também contam como escrita', async () => {
    const { key } = await issue();
    const h = makeHandler({ writesPerMinute: 3 });
    const { id } = await (await create(key, h)).json() as { id: string };
    expect((await call('PUT', `/api/quotes/${id}`, key, quote(), h)).status).toBe(200);
    expect((await call('DELETE', `/api/quotes/${id}`, key, undefined, h)).status).toBe(200);
    expect((await call('PUT', `/api/quotes/${id}`, key, quote(), h)).status).toBe(429);
  });
  it('é por licença e a verificação tem janela própria', async () => {
    const a = await issue(), b = await issue();
    const h = makeHandler({ writesPerMinute: 1, verifyPerMinute: 2 });
    expect((await create(a.key, h)).status).toBe(201);
    expect((await create(a.key, h)).status).toBe(429);
    expect((await create(b.key, h)).status).toBe(201);
    expect((await call('GET', '/api/license', a.key, undefined, h)).status).toBe(200);
    expect((await call('GET', '/api/license', a.key, undefined, h)).status).toBe(200);
    expect((await call('GET', '/api/license', a.key, undefined, h)).status).toBe(429);
  });
  it('concorrência: requisições simultâneas nunca ultrapassam o limite', async () => {
    const { key } = await issue();
    const h = makeHandler({ verifyPerMinute: 10 });
    const results = await Promise.all(Array.from({ length: 40 }, () => call('GET', '/api/license', key, undefined, h)));
    expect(results.filter(r => r.status === 200)).toHaveLength(10);
    expect(results.filter(r => r.status === 429)).toHaveLength(30);
  });
  it('limpa contadores de janelas antigas', async () => {
    const { key } = await issue();
    const h = makeHandler({ verifyPerMinute: 5 });
    await call('GET', '/api/license', key, undefined, h);
    clock = new Date(NOW.getTime() + 5 * 60_000);
    await call('GET', '/api/license', key, undefined, h);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()).toMatchObject({ n: 1 });
  });
  it('licença inválida ou sem cabeçalho não cria contadores no banco', async () => {
    await call('GET', '/api/license', generateLicenseKey());
    await call('POST', '/api/quotes', null, quote());
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()).toMatchObject({ n: 0 });
  });
});

describe('Sem vazamento da chave', () => {
  it('nenhuma resposta, log ou linha do banco contém a chave', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const { key, id } = await issue({ quotaActive: 1 });
    const h = makeHandler({ writesPerMinute: 5 });
    const other = generateLicenseKey();
    const responses = [
      await create(key, h), await create(key, h), // criada; cota excedida
      await call('POST', '/api/quotes', key, { version: 1, lixo: true }, h), await call('POST', '/api/quotes', key, quote(), h), // inválida; limite de taxa
      await call('GET', '/api/license', key, undefined, h), await call('PUT', '/api/quotes/inexistente', key, quote(), h),
      await call('POST', '/api/quotes', key, quote(), h), // 6ª escrita na janela: limite de taxa
      await call('POST', '/api/quotes', other, quote(), h), await call('POST', '/api/quotes', `${key}x`, quote(), h), // chave inexistente; malformada
    ];
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    responses.push(await call('POST', '/api/quotes', key, quote(), h)); // revogada
    const broken = await handle(new Request(`${BASE}/api/quotes`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' }), { DB: { prepare() { throw new Error(`falha com ${key}`); } } } as unknown as Env);
    responses.push(broken);
    expect(broken.status).toBe(500);
    expect(responses.map(r => r.status)).toEqual([201, 429, 400, 429, 200, 404, 429, 401, 401, 403, 500]);
    for (const r of responses) { const text = await dumpResponse(r); expect(text).not.toContain(key); expect(text).not.toContain(other); expect(text).not.toContain('falha com'); }
    expect(everything()).not.toContain(key);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it('o link devolvido na criação e a página pública não trazem a chave', async () => {
    const { key } = await issue();
    const { url, id } = await (await create(key)).json() as { url: string; id: string };
    expect(url).not.toContain(key.slice(9));
    const page = await dumpResponse(await call('GET', `/o/${id}`, null));
    expect(page).not.toContain(key.slice(9));
  });
});

describe('CORS para o app', () => {
  it('permite só origens configuradas, com Authorization nos cabeçalhos permitidos', async () => {
    const pre = await handle(new Request(`${BASE}/api/license`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5174');
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');
    const bad = await handle(new Request(`${BASE}/api/license`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const { key } = await issue();
    const res = await call('GET', '/api/license', key, undefined, handle, { origin: 'http://localhost:5174' });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5174');
    expect((await call('GET', '/api/license', key, undefined, handle, { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBe('true'); // cookie de sessão, só para origens autorizadas
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-CSRF-Token');
    expect(bad.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('sem ALLOWED_ORIGINS nenhuma origem é liberada', async () => {
    const res = await handle(new Request(`${BASE}/api/license`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5174' } }), { DB: db.d1 });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Administração de licenças (SQL do CLI)', () => {
  it('emite com rótulo e cotas; o status e a lista nunca expõem o hash', async () => {
    const { key, id } = await issue({ label: 'Pedido 123 (Bia)', quotaActive: 7, quotaDaily: 3 });
    await create(key);
    const day = '2026-11-12T03:00:00.000Z';
    const [row] = db.raw.prepare(licenseStatusSql(id, day)).all() as Record<string, unknown>[];
    expect(row).toMatchObject({ id, label: 'Pedido 123 (Bia)', status: 'active', quota_active: 7, quota_daily: 3, active_quotes: 1, created_today: 1 });
    expect(Object.keys(row)).not.toContain('key_hash');
    expect(JSON.stringify(db.raw.prepare(listLicensesSql(day)).all())).not.toContain(await hashLicenseKey(key));
  });
  it('revogar com retirada de orçamentos só afeta o proprietário indicado', async () => {
    const a = await issue(), b = await issue();
    await create(a.key); await create(b.key);
    db.raw.exec(setLicenseStatusSql(a.id, 'revoked', NOW.toISOString()));
    db.raw.exec(revokeLicenseQuotesSql(a.id, NOW.toISOString()));
    const rows = db.rows();
    expect(rows.find(r => r.owner_id === a.id)!.revoked_at).toBe(NOW.toISOString());
    expect(rows.find(r => r.owner_id === b.id)!.revoked_at).toBeNull();
  });
  it('rejeita entradas perigosas ou inválidas', async () => {
    const hash = await hashLicenseKey(generateLicenseKey());
    const base = { id: generateLicenseId(), keyHash: hash, quotaActive: 1, quotaDaily: 1, now: NOW.toISOString() };
    expect(() => issueLicenseSql({ ...base, label: "x'); DROP TABLE licenses; --" })).toThrow('Rótulo');
    expect(() => issueLicenseSql({ ...base, label: "d'Ávila" })).toThrow('Rótulo');
    expect(() => issueLicenseSql({ ...base, label: 'x'.repeat(61) })).toThrow('Rótulo');
    expect(() => issueLicenseSql({ ...base, keyHash: 'abc' })).toThrow('Hash');
    expect(() => issueLicenseSql({ ...base, id: "lic_'; DROP" })).toThrow('Identificador');
    expect(() => issueLicenseSql({ ...base, quotaActive: -1 })).toThrow('Cota');
    expect(() => issueLicenseSql({ ...base, quotaDaily: 1.5 })).toThrow('Cota');
    expect(() => issueLicenseSql({ ...base, now: "2026'; --" })).toThrow('Data');
    expect(() => setLicenseStatusSql('x', 'active', NOW.toISOString())).toThrow('Identificador');
    expect(() => licenseStatusSql("lic_0000000000000000' OR '1'='1", '2026-11-12T03:00:00.000Z')).toThrow('Identificador');
  });
  it('não permite duas licenças com o mesmo hash', async () => {
    const hash = await hashLicenseKey(generateLicenseKey());
    const sql = (id: string) => issueLicenseSql({ id, keyHash: hash, quotaActive: 1, quotaDaily: 1, now: NOW.toISOString() });
    db.raw.exec(sql(generateLicenseId()));
    expect(() => db.raw.exec(sql(generateLicenseId()))).toThrow();
  });
});
