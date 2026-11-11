import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_MAX_ATTEMPTS, MAX_SESSIONS, generateNumericCode, hmacHex, normalizeDeviceLabel, normalizeEmail, sha256Hex, timingSafeEqual } from '../worker/src/accounts';
import { insertSessionWithinLimit } from '../worker/src/accountStore';
import { LOGIN_LIMITS } from '../worker/src/authRoutes';
import { createLicenseAuthorizer } from '../worker/src/auth';
import { MemoryEmailSender } from '../worker/src/email';
import worker, { createHandler, type Env } from '../worker/src/index';
import { bindLicenseEmailSql, issueLicenseSql, licenseStatusSql, revokeLicenseSessionsSql, setLicenseStatusSql } from '../worker/src/licenseAdmin';
import { generateLicenseId, generateLicenseKey, hashLicenseKey } from '../worker/src/licenses';
import { createCompositeAuthorizer, createSessionAuthorizer } from '../worker/src/session';
import type { PublicQuote } from '../shared/publicQuote';
import { createTestD1 } from './helpers/d1';

const BASE = 'https://api.exemplo.test';
const ORIGIN = 'http://localhost:5174';
const SECRET = 'segredo-de-teste-que-so-existe-no-ambiente-de-teste';
const NOW = new Date('2026-11-12T15:00:00Z');
const quote = (): PublicQuote => ({ version: 1, quoteNumber: '001', businessName: 'Doces da Bia', issuedAt: '2026-11-11', items: [{ description: 'Bolo', quantity: 1, unitPriceCents: 5000 }] });

let db: ReturnType<typeof createTestD1>;
let env: Env;
let mail: MemoryEmailSender;
let clock: Date;
beforeEach(() => { db = createTestD1(); mail = new MemoryEmailSender(); clock = new Date(NOW); env = { DB: db.d1, PUBLIC_BASE_URL: BASE, ALLOWED_ORIGINS: ORIGIN, AUTH_SECRET: SECRET }; });
afterEach(() => vi.restoreAllMocks());

const makeHandler = (sessionOpts = {}) => createHandler({ authorize: createCompositeAuthorizer(createLicenseAuthorizer(), createSessionAuthorizer(sessionOpts)), now: () => clock, email: () => mail });
const handle = makeHandler({ writesPerMinute: 1000, verifyPerMinute: 1000 });

type Opts = { body?: unknown; cookie?: string; csrf?: string; origin?: string | null; ip?: string; base?: string; headers?: Record<string, string> };
const call = (method: string, path: string, o: Opts = {}, h = handle) => h(new Request(`${o.base ?? BASE}${path}`, {
  method,
  headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
  ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
}), env);

async function issueFor(email: string, over: { quotaActive?: number; quotaDaily?: number } = {}) {
  const id = generateLicenseId();
  db.raw.exec(issueLicenseSql({ id, keyHash: await hashLicenseKey(generateLicenseKey()), email, quotaActive: over.quotaActive ?? 100, quotaDaily: over.quotaDaily ?? 30, now: NOW.toISOString() }));
  return id;
}
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0];
type Login = { res: Response; body: Record<string, unknown>; cookie: string; csrf: string; sessionId: string };
async function login(email: string, label = 'Celular', extra: { replaceSessionId?: string; ip?: string } = {}): Promise<Login> {
  if (!extra.replaceSessionId) { const r = await call('POST', '/api/auth/request-code', { body: { email }, ip: extra.ip }); expect(r.status).toBe(202); }
  const res = await call('POST', '/api/auth/verify-code', { body: { email, code: mail.lastCode(), deviceLabel: label, ...(extra.replaceSessionId ? { replaceSessionId: extra.replaceSessionId } : {}) }, ip: extra.ip });
  const body = await res.clone().json() as Record<string, unknown>;
  return { res, body, cookie: res.headers.get('set-cookie') ? cookieOf(res) : '', csrf: String(body.csrfToken ?? ''), sessionId: String(body.sessionId ?? '') };
}
const asUser = (s: Login) => ({ cookie: s.cookie, csrf: s.csrf });
const dump = () => JSON.stringify(['users', 'licenses', 'sessions', 'auth_codes', 'rate_limits', 'quotes'].map(t => db.raw.prepare(`SELECT * FROM ${t}`).all()));
const table = (name: string) => db.raw.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];

describe('Primitivas', () => {
  it('códigos de 8 dígitos uniformes e com zeros à esquerda', () => {
    const seen = new Set(Array.from({ length: 300 }, () => generateNumericCode()));
    for (const c of seen) expect(c).toMatch(/^\d{8}$/);
    expect(seen.size).toBeGreaterThan(290);
  });
  it('normaliza e valida e-mails e rótulos', () => {
    expect(normalizeEmail('  Bia@Exemplo.COM ')).toBe('bia@exemplo.com');
    for (const bad of ['', 'sem-arroba', 'a@b', 'a b@c.com', 'a@@c.com', '<x>@c.com', 'a@c.com,b@c.com', 'a@c.com;b', 5, null, `${'a'.repeat(250)}@c.com`]) expect(normalizeEmail(bad), String(bad)).toBeUndefined();
    expect(normalizeDeviceLabel('  Celular‮ da Bia \n')).toBe('Celular da Bia'); expect(normalizeDeviceLabel('x'.repeat(100))).toHaveLength(60); expect(normalizeDeviceLabel('')).toBeNull();
  });
  it('comparação em tempo constante e HMAC dependem do segredo', async () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true); expect(timingSafeEqual('abc', 'abd')).toBe(false); expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(await hmacHex('a', 'm')).not.toBe(await hmacHex('b', 'm'));
    expect(await sha256Hex('x')).toHaveLength(64);
  });
});

describe('Pedido de código', () => {
  it('envia um código de 8 dígitos ao e-mail com licença e guarda só o HMAC dele', async () => {
    await issueFor('bia@exemplo.com');
    const res = await call('POST', '/api/auth/request-code', { body: { email: ' Bia@Exemplo.com ' } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, expiresInMinutes: 10 });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0].to).toBe('bia@exemplo.com');
    const code = mail.lastCode()!;
    expect(code).toMatch(/^\d{8}$/);
    expect(dump()).not.toContain(code);
    expect(table('auth_codes')[0].code_hash).toBe(await hmacHex(SECRET, `bia@exemplo.com|${code}`));
  });
  it('e-mail sem licença (ou com licença revogada) recebe a MESMA resposta e nenhum e-mail', async () => {
    const id = await issueFor('revogada@exemplo.com');
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    const a = await call('POST', '/api/auth/request-code', { body: { email: 'ninguem@exemplo.com' } });
    const b = await call('POST', '/api/auth/request-code', { body: { email: 'revogada@exemplo.com' } });
    await issueFor('bia@exemplo.com');
    const c = await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    expect(await a.json()).toEqual(await c.json());
    expect(mail.outbox).toHaveLength(1);
    expect(table('auth_codes')).toHaveLength(1);
  });
  it('e-mail inválido → 400; corpo grande ou quebrado → erro, sem enviar nada', async () => {
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'xyz' } })).status).toBe(400);
    expect((await call('POST', '/api/auth/request-code', { body: {} })).status).toBe(400);
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'a@b.com', lixo: 'x'.repeat(5000) } })).status).toBe(413);
    expect((await handle(new Request(`${BASE}/api/auth/request-code`, { method: 'POST', body: '{quebrado' }), env)).status).toBe(400);
    expect(mail.outbox).toHaveLength(0);
  });
  it('sem AUTH_SECRET ou sem provedor de e-mail configurado → 503, sem fingir envio', async () => {
    await issueFor('bia@exemplo.com');
    env = { ...env, AUTH_SECRET: undefined };
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } })).status).toBe(503);
    env = { ...env, AUTH_SECRET: SECRET };
    const noProvider = createHandler({ authorize: createSessionAuthorizer(), now: () => clock }); // fábrica padrão: sem EMAIL_ADAPTER
    for (const email of ['bia@exemplo.com', 'ninguem@exemplo.com']) {
      const res = await call('POST', '/api/auth/request-code', { body: { email } }, noProvider);
      expect(res.status).toBe(503); expect(await res.json()).toMatchObject({ error: 'EMAIL_NOT_CONFIGURED' });
    }
    expect(table('auth_codes')).toHaveLength(0);
  });
  it('o adaptador de desenvolvimento só existe com EMAIL_ADAPTER=dev e avisa que não entrega', async () => {
    await issueFor('bia@exemplo.com');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    env = { ...env, EMAIL_ADAPTER: 'dev' };
    const dev = createHandler({ authorize: createSessionAuthorizer(), now: () => clock });
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } }, dev)).status).toBe(202);
    expect(String(log.mock.calls[0][0])).toContain('DE DESENVOLVIMENTO, não entregue');
  });
  it('falha no envio → 503 e nenhum código válido sobra', async () => {
    await issueFor('bia@exemplo.com');
    mail.failNext = true;
    const res = await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    expect(res.status).toBe(503); expect(await res.json()).toMatchObject({ error: 'EMAIL_SEND_FAILED' });
    const v = await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: '12345678' } });
    expect(v.status).toBe(401);
    expect(table('auth_codes').every(c => c.used_at !== null)).toBe(true);
  });
  it('um novo código invalida o anterior', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const first = mail.lastCode()!;
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const second = mail.lastCode()!;
    if (first !== second) expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: first } })).status).toBe(401);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: second } })).status).toBe(200);
  });
  it('limite por e-mail: 5 pedidos por hora, sem afetar outro e-mail nem sessões existentes', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const session = await login('bia@exemplo.com');
    for (let i = 0; i < LOGIN_LIMITS.requestPerEmail - 1; i++) expect((await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' }, ip: `10.0.0.${i}` })).status).toBe(202);
    const limited = await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' }, ip: '10.9.9.9' });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'ana@exemplo.com' }, ip: '10.9.9.9' })).status).toBe(202);
    expect((await call('GET', '/api/auth/session', asUser(session))).status).toBe(200); // quem já está logado não é bloqueado
    clock = new Date(NOW.getTime() + 3600_000);
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } })).status).toBe(202);
  });
  it('o limite por IP é só uma rede ampla: muda de IP e o e-mail continua protegido; e um IP não trava um e-mail sozinho', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/request-code', { body: { email: 'alvo@exemplo.com' }, ip: `1.1.1.${i}` });
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'alvo@exemplo.com' }, ip: '2.2.2.2' })).status).toBe(429); // o e-mail continua limitado em outro IP
    for (let i = 0; i < LOGIN_LIMITS.requestPerIp; i++) expect((await call('POST', '/api/auth/request-code', { body: { email: `u${i}@exemplo.com` }, ip: '3.3.3.3' })).status).toBe(202);
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'novo@exemplo.com' }, ip: '3.3.3.3' })).status).toBe(429);
    expect((await call('POST', '/api/auth/request-code', { body: { email: 'novo@exemplo.com' }, ip: '4.4.4.4' })).status).toBe(202); // o mesmo e-mail, em outro IP, não está preso
  });
});

describe('Verificação do código e sessão', () => {
  it('código correto abre a sessão: cookie HttpOnly/Secure/SameSite, conta verificada e licença vinculada', async () => {
    const licenseId = await issueFor('bia@exemplo.com', { quotaActive: 7, quotaDaily: 3 });
    const s = await login('bia@exemplo.com', 'Celular da Bia');
    expect(s.res.status).toBe(200);
    const setCookie = s.res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^__Host-dabi_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    expect(s.body).toMatchObject({ user: { email: 'bia@exemplo.com' }, license: { status: 'active', quotaActive: 7, quotaDaily: 3 } });
    expect(String(s.body.csrfToken).length).toBeGreaterThan(20);
    const [user] = table('users');
    expect(user).toMatchObject({ email: 'bia@exemplo.com' }); expect(user.email_verified_at).toBe(NOW.toISOString());
    expect(table('licenses')[0]).toMatchObject({ id: licenseId, user_id: user.id });
    expect(table('sessions')[0]).toMatchObject({ device_label: 'Celular da Bia', user_id: user.id });
  });
  it('o token da sessão nunca vai ao corpo da resposta nem é gravado em texto puro', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    const token = s.cookie.split('=')[1];
    expect(JSON.stringify(s.body)).not.toContain(token);
    expect(dump()).not.toContain(token);
    expect(table('sessions')[0].token_hash).toBe(await sha256Hex(token));
  });
  it('em http (localhost de desenvolvimento) o cookie não leva Secure nem o prefixo __Host-', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' }, base: 'http://localhost:8787' });
    const res = await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: mail.lastCode() }, base: 'http://localhost:8787' });
    expect(res.headers.get('set-cookie')).toMatch(/^dabi_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });
  it('código errado, expirado, reutilizado ou de e-mail sem conta → 401 genérico', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const code = mail.lastCode()!;
    const wrong = code === '00000000' ? '11111111' : '00000000';
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: wrong } })).status).toBe(401);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'ninguem@exemplo.com', code } })).status).toBe(401);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code } })).status).toBe(200);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code } })).status).toBe(401); // uso único
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const late = mail.lastCode()!;
    clock = new Date(NOW.getTime() + 10 * 60_000 + 1000);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: late } })).status).toBe(401); // expirou
  });
  it('formato inválido de código ou de sessão a substituir → 400', async () => {
    for (const code of ['abc', '1234567', '123456789', 12345678, null]) expect((await call('POST', '/api/auth/verify-code', { body: { email: 'a@b.com', code } })).status, String(code)).toBe(400);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'a@b.com', code: '12345678', replaceSessionId: '../x' } })).status).toBe(400);
  });
  it('após 5 tentativas erradas o código é queimado, mesmo se a próxima for a certa', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const code = mail.lastCode()!; const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: wrong } })).status).toBe(401);
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code } })).status).toBe(401);
    expect(table('sessions')).toHaveLength(0);
  });
  it('concorrência: tentativas simultâneas nunca passam do limite por código', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const wrong = mail.lastCode() === '00000000' ? '11111111' : '00000000';
    await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: wrong } })));
    expect(table('auth_codes')[0].attempts).toBe(CODE_MAX_ATTEMPTS);
  });
  it('concorrência: o mesmo código correto abre no máximo UMA sessão', async () => {
    await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const code = mail.lastCode()!;
    const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code } })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(table('sessions')).toHaveLength(1);
  });
  it('limite de verificações por e-mail por hora', async () => {
    for (let i = 0; i < LOGIN_LIMITS.verifyPerEmail; i++) await call('POST', '/api/auth/verify-code', { body: { email: 'alvo@exemplo.com', code: '00000000' }, ip: `9.9.9.${i}` });
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'alvo@exemplo.com', code: '00000000' }, ip: '8.8.8.8' })).status).toBe(429);
  });
  it('licença revogada (ou conta sem licença) não consegue entrar', async () => {
    const id = await issueFor('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const code = mail.lastCode()!;
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    const res = await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code } });
    expect(res.status).toBe(403); expect(await res.json()).toMatchObject({ error: 'NO_ACTIVE_LICENSE' });
    expect(table('sessions')).toHaveLength(0);
  });
});

describe('Dispositivos (até duas sessões)', () => {
  it('a terceira instalação é recusada com a lista (sem tokens) e o código continua válido', async () => {
    await issueFor('bia@exemplo.com');
    const a = await login('bia@exemplo.com', 'Celular'); const b = await login('bia@exemplo.com', 'Notebook');
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    const res = await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: mail.lastCode(), deviceLabel: 'Tablet' } });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; sessions: Record<string, unknown>[] };
    expect(body.error).toBe('DEVICE_LIMIT'); expect(body.sessions.map(s => s.deviceLabel)).toEqual(['Celular', 'Notebook']);
    expect(JSON.stringify(body)).not.toMatch(/token|csrf/i);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(table('sessions')).toHaveLength(MAX_SESSIONS);
    // o mesmo código serve para substituir um dispositivo
    const replaced = await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: mail.lastCode(), deviceLabel: 'Tablet', replaceSessionId: a.sessionId } });
    expect(replaced.status).toBe(200);
    expect((await call('GET', '/api/auth/session', asUser(a))).status).toBe(401); // o celular foi desconectado
    expect((await call('GET', '/api/auth/session', asUser(b))).status).toBe(200);
    expect(table('sessions').filter(s => s.revoked_at === null)).toHaveLength(MAX_SESSIONS);
  });
  it('substituir uma sessão inexistente ou de outra conta → 400 e nada é revogado', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const ana = await login('ana@exemplo.com');
    await login('bia@exemplo.com'); await login('bia@exemplo.com');
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    for (const replaceSessionId of [ana.sessionId, 'ses_0000000000000000']) {
      expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: mail.lastCode(), replaceSessionId } })).status).toBe(400);
    }
    expect((await call('GET', '/api/auth/session', asUser(ana))).status).toBe(200);
  });
  it('concorrência: nunca existem mais de 2 sessões ativas por usuário', async () => {
    const now = NOW.toISOString();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => insertSessionWithinLimit(db.d1, { id: `ses_${String(i).padStart(16, '0')}`, user_id: 'usr_x', token_hash: `h${i}`, csrf_token: 'c', device_label: null, created_at: now, last_seen_at: now, expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() }, now, MAX_SESSIONS)));
    expect(results.filter(Boolean)).toHaveLength(MAX_SESSIONS);
    expect(table('sessions')).toHaveLength(MAX_SESSIONS);
  });
  it('sessões expiradas não ocupam vaga', async () => {
    await issueFor('bia@exemplo.com');
    await login('bia@exemplo.com'); await login('bia@exemplo.com');
    clock = new Date(NOW.getTime() + 31 * 86_400_000);
    await call('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.com' } });
    expect((await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: mail.lastCode() } })).status).toBe(200);
  });
  it('lista os próprios dispositivos, remove um outro dispositivo e encerra a sessão atual', async () => {
    await issueFor('bia@exemplo.com');
    const a = await login('bia@exemplo.com', 'Celular'); const b = await login('bia@exemplo.com', 'Notebook');
    const list = await (await call('GET', '/api/sessions', asUser(a))).json() as { maxSessions: number; sessions: { id: string; deviceLabel: string; current: boolean }[] };
    expect(list.maxSessions).toBe(2); expect(list.sessions.map(s => [s.deviceLabel, s.current])).toEqual([['Celular', true], ['Notebook', false]]);
    expect(JSON.stringify(list)).not.toMatch(/token|csrf/i);
    const del = await call('DELETE', `/api/sessions/${b.sessionId}`, asUser(a));
    expect(del.status).toBe(200); expect(del.headers.get('set-cookie')).toBeNull();
    expect((await call('GET', '/api/auth/session', asUser(b))).status).toBe(401);
    const self = await call('DELETE', `/api/sessions/${a.sessionId}`, asUser(a));
    expect(self.status).toBe(200); expect(self.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await call('GET', '/api/auth/session', asUser(a))).status).toBe(401);
  });
  it('logout revoga a sessão e limpa o cookie; sem CSRF é recusado', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    expect((await call('POST', '/api/auth/logout', { cookie: s.cookie })).status).toBe(403);
    expect((await call('GET', '/api/auth/session', asUser(s))).status).toBe(200);
    const out = await call('POST', '/api/auth/logout', asUser(s));
    expect(out.status).toBe(200); expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await call('GET', '/api/auth/session', asUser(s))).status).toBe(401);
  });
  it('a sessão expira em 30 dias e uma conta não enxerga nem remove dispositivos de outra', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const bia = await login('bia@exemplo.com'); const ana = await login('ana@exemplo.com');
    expect((await call('DELETE', `/api/sessions/${ana.sessionId}`, asUser(bia))).status).toBe(404);
    expect((await call('GET', '/api/auth/session', asUser(ana))).status).toBe(200);
    expect(JSON.stringify(await (await call('GET', '/api/sessions', asUser(bia))).json())).not.toContain(ana.sessionId);
    clock = new Date(NOW.getTime() + 30 * 86_400_000 + 1000);
    expect((await call('GET', '/api/auth/session', asUser(bia))).status).toBe(401);
  });
  it('cookie inventado, truncado ou de outra sessão → 401', async () => {
    for (const cookie of ['__Host-dabi_session=', '__Host-dabi_session=abc', `__Host-dabi_session=${'x'.repeat(43)}`, `__Host-dabi_session=${'x'.repeat(500)}`, 'outro=1']) expect((await call('GET', '/api/auth/session', { cookie })).status, cookie).toBe(401);
  });
});

describe('Operações protegidas com sessão (CSRF e isolamento)', () => {
  it('cria orçamento com sessão válida; o dono é a licença da conta', async () => {
    const id = await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    const res = await call('POST', '/api/quotes', { ...asUser(s), body: quote() });
    expect(res.status).toBe(201);
    expect(table('quotes')[0].owner_id).toBe(id);
  });
  it('sem CSRF, com CSRF errado, sem Origin ou com Origin não autorizado → 403 e nada é gravado', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    const attempts: Opts[] = [{ cookie: s.cookie }, { cookie: s.cookie, csrf: 'errado' }, { cookie: s.cookie, csrf: s.csrf, origin: null }, { cookie: s.cookie, csrf: s.csrf, origin: 'https://evil.example' }, { cookie: s.cookie, csrf: s.csrf.slice(0, -1) }];
    for (const a of attempts) {
      const res = await call('POST', '/api/quotes', { ...a, body: quote() });
      expect(res.status, JSON.stringify(a)).toBe(403); expect(await res.json()).toMatchObject({ error: 'CSRF' });
    }
    expect((await call('DELETE', '/api/quotes/AAAAAAAAAAAAAAAAAAAAAA', { cookie: s.cookie })).status).toBe(403);
    expect(table('quotes')).toHaveLength(0);
  });
  it('o CSRF de uma sessão não vale em outra', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const bia = await login('bia@exemplo.com'); const ana = await login('ana@exemplo.com');
    expect((await call('POST', '/api/quotes', { cookie: bia.cookie, csrf: ana.csrf, body: quote() })).status).toBe(403);
  });
  it('um comprador não altera nem revoga orçamentos de outro', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const bia = await login('bia@exemplo.com'); const ana = await login('ana@exemplo.com');
    const { id } = await (await call('POST', '/api/quotes', { ...asUser(bia), body: quote() })).json() as { id: string };
    expect((await call('PUT', `/api/quotes/${id}`, { ...asUser(ana), body: { ...quote(), businessName: 'Invasora' } })).status).toBe(404);
    expect((await call('DELETE', `/api/quotes/${id}`, asUser(ana))).status).toBe(404);
    expect(JSON.parse(table('quotes')[0].payload as string).businessName).toBe('Doces da Bia');
    expect((await call('DELETE', `/api/quotes/${id}`, asUser(bia))).status).toBe(200);
  });
  it('leitura pública não exige sessão nem CSRF', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    const { id } = await (await call('POST', '/api/quotes', { ...asUser(s), body: quote() })).json() as { id: string };
    for (const o of [{}, { cookie: 'dabi_session=lixo' }]) { expect((await call('GET', `/o/${id}`, o)).status).toBe(200); expect((await call('GET', `/api/quotes/${id}`, o)).status).toBe(200); }
  });
  it('licença revogada: sessões encerradas pelo CLI deixam de funcionar; sem isso, as operações dão 403', async () => {
    const id = await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    db.raw.exec(setLicenseStatusSql(id, 'revoked', NOW.toISOString()));
    const res = await call('POST', '/api/quotes', { ...asUser(s), body: quote() });
    expect(res.status).toBe(403); expect(await res.json()).toMatchObject({ error: 'LICENSE_REVOKED' });
    expect((await call('GET', '/api/auth/session', asUser(s))).status).toBe(200); // a conta continua identificável (mostra licença revogada)
    db.raw.exec(revokeLicenseSessionsSql(id, NOW.toISOString()));
    expect((await call('GET', '/api/auth/session', asUser(s))).status).toBe(401);
  });
  it('conta sem licença vinculada não opera', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    db.raw.exec("UPDATE licenses SET user_id = NULL");
    expect(await (await call('POST', '/api/quotes', { ...asUser(s), body: quote() })).json()).toMatchObject({ error: 'NO_ACTIVE_LICENSE' });
  });
  it('cotas e limite de taxa continuam valendo para sessões', async () => {
    await issueFor('bia@exemplo.com', { quotaActive: 1 });
    const s = await login('bia@exemplo.com');
    expect((await call('POST', '/api/quotes', { ...asUser(s), body: quote() })).status).toBe(201);
    expect(await (await call('POST', '/api/quotes', { ...asUser(s), body: quote() })).json()).toMatchObject({ error: 'QUOTA_ACTIVE_EXCEEDED' });
    const slow = makeHandler({ writesPerMinute: 2 });
    expect((await call('POST', '/api/quotes', { ...asUser(s), body: quote() }, slow)).status).toBe(429);
    expect((await call('POST', '/api/quotes', { ...asUser(s), body: quote() }, slow)).status).toBe(429);
    const limited = await call('POST', '/api/quotes', { ...asUser(s), body: quote() }, slow);
    expect(limited.status).toBe(429); expect(await limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
  });
  it('/api/license mostra o uso das cotas também para sessões', async () => {
    const id = await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    expect(await (await call('GET', '/api/license', asUser(s))).json()).toMatchObject({ status: 'active', licenseId: id });
  });
  it('a chave de licença antiga não é fator permanente: só vale com LEGACY_KEY_AUTH=on e nunca com sessão ativa', async () => {
    const key = generateLicenseKey(); const id = generateLicenseId();
    db.raw.exec(issueLicenseSql({ id, keyHash: await hashLicenseKey(key), quotaActive: 5, quotaDaily: 5, now: NOW.toISOString() }));
    const bearer = { headers: { authorization: `Bearer ${key}` } };
    expect((await worker.fetch(new Request(`${BASE}/api/license`, { headers: bearer.headers }), env)).status).toBe(401);
    expect((await worker.fetch(new Request(`${BASE}/api/license`, { headers: bearer.headers }), { ...env, LEGACY_KEY_AUTH: 'on' })).status).toBe(200);
  });
});

describe('Listagem dos próprios links (GET /api/quotes)', () => {
  it('lista só os orçamentos do dono, com status e total, sem dados internos; outra conta não vê', async () => {
    await issueFor('bia@exemplo.com'); await issueFor('ana@exemplo.com');
    const bia = await login('bia@exemplo.com'); const ana = await login('ana@exemplo.com');
    const mk = async (n: string, over: Partial<PublicQuote> = {}) => { clock = new Date(clock.getTime() + 60_000); const r = await call('POST', '/api/quotes', { ...asUser(bia), body: { ...quote(), quoteNumber: n, ...over } }); expect(r.status).toBe(201); return r; };
    const first = await (await mk('A1', { validUntil: '2026-11-13' })).json() as { id: string };
    const second = await (await mk('A2', { validUntil: '2026-11-11', deliveryFeeCents: 1000 })).json() as { id: string }; // hoje (12/11) já passou da validade
    const third = await (await mk('A3')).json() as { id: string };
    await call('DELETE', `/api/quotes/${third.id}`, asUser(bia));
    await call('POST', '/api/quotes', { ...asUser(ana), body: { ...quote(), quoteNumber: 'ANA' } });
    const list = await (await call('GET', '/api/quotes', asUser(bia))).json() as { quotes: Record<string, unknown>[] };
    expect(list.quotes.map(q => [q.quoteNumber, q.status])).toEqual([['A3', 'revoked'], ['A2', 'expired'], ['A1', 'active']]); // mais recentes primeiro
    expect(list.quotes.find(q => q.id === second.id)).toMatchObject({ totalCents: 6000, url: `${BASE}/o/${second.id}` });
    expect(list.quotes.some(q => q.id === first.id)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/owner|payload|ANA|csrf|token/i);
    const mine = await (await call('GET', '/api/quotes', asUser(ana))).json() as { quotes: { quoteNumber: string }[] };
    expect(mine.quotes.map(q => q.quoteNumber)).toEqual(['ANA']);
  });
  it('sem sessão: 401; leitura não exige CSRF', async () => {
    expect((await call('GET', '/api/quotes')).status).toBe(401);
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    expect((await call('GET', '/api/quotes', { cookie: s.cookie })).status).toBe(200);
  });
});

describe('Rotas e cabeçalhos', () => {
  it('rotas desconhecidas e métodos errados', async () => {
    expect((await call('GET', '/api/auth/request-code')).status).toBe(404);
    expect((await call('POST', '/api/auth/session')).status).toBe(404);
    expect((await call('GET', '/api/auth/nada')).status).toBe(404);
    expect((await call('PUT', '/api/sessions')).status).toBe(404);
  });
  it('respostas de autenticação nunca são guardadas em cache', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    for (const res of [s.res, await call('GET', '/api/auth/session', asUser(s)), await call('GET', '/api/sessions', asUser(s))]) expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('a pré-verificação CORS aceita só origens autorizadas e permite credenciais e X-CSRF-Token', async () => {
    const ok = await call('OPTIONS', '/api/auth/verify-code', { origin: ORIGIN });
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true'); expect(ok.headers.get('access-control-allow-headers')).toContain('X-CSRF-Token');
    const no = await call('OPTIONS', '/api/auth/verify-code', { origin: 'https://evil.example' });
    expect(no.headers.get('access-control-allow-origin')).toBeNull(); expect(no.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('Sem vazamento de segredos', () => {
  it('nenhum log registra código, token, CSRF ou segredo durante todo o fluxo', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    await call('POST', '/api/quotes', { ...asUser(s), body: quote() });
    await call('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.com', code: '00000000' } });
    const broken = await handle(new Request(`${BASE}/api/auth/request-code`, { method: 'POST', body: JSON.stringify({ email: 'bia@exemplo.com' }) }), { ...env, DB: { prepare() { throw new Error(`falha ${SECRET} ${s.csrf}`); } } as unknown as Env['DB'] });
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain(SECRET);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it('o segredo e o CSRF não aparecem em respostas indevidas nem no banco', async () => {
    await issueFor('bia@exemplo.com');
    const s = await login('bia@exemplo.com');
    expect(dump()).not.toContain(SECRET);
    const list = JSON.stringify(await (await call('GET', '/api/sessions', asUser(s))).json());
    expect(list).not.toContain(s.csrf);
  });
});

describe('Administração (SQL do CLI) para contas', () => {
  it('licença de conta: e-mail único, normalizado e visível no status', async () => {
    const id = await issueFor('Bia@Exemplo.com');
    const [row] = db.raw.prepare(licenseStatusSql(id, '2026-11-12T03:00:00.000Z')).all() as Record<string, unknown>[];
    expect(row).toMatchObject({ id, email: 'bia@exemplo.com', active_sessions: 0 });
    expect(Object.keys(row)).not.toContain('key_hash');
    await expect(issueFor('bia@exemplo.com')).rejects.toThrow(); // um e-mail, uma licença
    expect(() => issueLicenseSql({ id: generateLicenseId(), keyHash: 'a'.repeat(64), email: "x'); DROP TABLE users;--", quotaActive: 1, quotaDaily: 1, now: NOW.toISOString() })).toThrow('E-mail');
  });
  it('vincular uma licença legada a um e-mail permite o login; o status conta os dispositivos', async () => {
    const id = generateLicenseId();
    db.raw.exec(issueLicenseSql({ id, keyHash: await hashLicenseKey(generateLicenseKey()), quotaActive: 5, quotaDaily: 5, now: NOW.toISOString() }));
    db.raw.exec(bindLicenseEmailSql(id, 'bia@exemplo.com'));
    await login('bia@exemplo.com');
    expect((db.raw.prepare(licenseStatusSql(id, '2026-11-12T03:00:00.000Z')).get() as Record<string, unknown>).active_sessions).toBe(1);
    db.raw.exec(bindLicenseEmailSql(id, 'outro@exemplo.com')); // já tinha e-mail: não muda
    expect(table('licenses')[0].email).toBe('bia@exemplo.com');
  });
});
