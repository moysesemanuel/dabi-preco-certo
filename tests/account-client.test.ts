import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiCall, safeApiBase } from '../src/account/http';
import { AUTH_MESSAGES, createAuthClient } from '../src/account/authClient';
import { makeServer } from './helpers/server';

const BASE = 'https://api.exemplo.test';
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const SESSION = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf-token-de-teste', sessionId: 'ses_0123456789abcdef', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };
afterEach(() => vi.restoreAllMocks());

describe('Configuração da API', () => {
  it('só aceita https (ou http em localhost) para não expor a sessão em texto puro', () => {
    expect(safeApiBase('https://api.exemplo.test/qualquer/caminho')).toBe('https://api.exemplo.test');
    expect(safeApiBase('http://localhost:8787')).toBe('http://localhost:8787'); expect(safeApiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    for (const bad of ['http://api.exemplo.test', 'ftp://x.test', 'javascript:alert(1)', 'lixo', '', undefined]) expect(safeApiBase(bad), String(bad)).toBeUndefined();
  });
  it('as chamadas levam cookie (credentials), sem cache e sem referrer; o CSRF só quando informado; nada de segredo na URL', async () => {
    const f = reply(200, {});
    await apiCall(BASE, '/api/x', { method: 'POST', body: { a: 1 }, csrf: 'tok' }, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/x`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
    await apiCall(BASE, '/api/y', {}, f);
    expect(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit).headers).toEqual({});
  });
  it('erro de rede vira null; corpo inválido não derruba', async () => {
    expect(await apiCall(BASE, '/x', {}, vi.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch)).toBeNull();
    expect(await apiCall(BASE, '/x', {}, vi.fn(async () => new Response('não é json', { status: 200 })) as unknown as typeof fetch)).toMatchObject({ status: 200, body: null });
  });
});

describe('Cliente de autenticação', () => {
  it('pedir código: sucesso e a mesma resposta genérica', async () => {
    expect(await createAuthClient(BASE, reply(202, { ok: true, expiresInMinutes: 10 })).requestCode('bia@exemplo.com')).toEqual({ ok: true, value: { expiresInMinutes: 10 } });
  });
  it('mapeia os erros do servidor para motivos claros', async () => {
    const c = (status: number, body: unknown = {}, h = {}) => createAuthClient(BASE, reply(status, body, h));
    expect(await c(429, {}, { 'retry-after': '120' }).requestCode('a@b.com')).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 120 });
    expect(await c(503, { error: 'EMAIL_NOT_CONFIGURED' }).requestCode('a@b.com')).toMatchObject({ reason: 'email-not-configured' });
    expect(await c(503, { error: 'AUTH_NOT_CONFIGURED' }).requestCode('a@b.com')).toMatchObject({ reason: 'auth-not-configured' });
    expect(await c(400, { error: 'INVALID_EMAIL' }).requestCode('x')).toMatchObject({ reason: 'invalid-request' });
    expect(await c(401, { error: 'INVALID_CODE' }).verifyCode({ email: 'a@b.com', code: '12345678' })).toEqual({ ok: false, reason: 'invalid-code' });
    expect(await c(403, { error: 'NO_ACTIVE_LICENSE' }).verifyCode({ email: 'a@b.com', code: '12345678' })).toEqual({ ok: false, reason: 'no-license' });
    expect(await c(500).requestCode('a@b.com')).toMatchObject({ reason: 'unexpected' });
    expect(await createAuthClient(BASE, vi.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch).requestCode('a@b.com')).toEqual({ ok: false, reason: 'network' });
    for (const reason of ['network', 'invalid-code', 'rate-limited', 'no-license', 'unauthorized', 'email-not-configured', 'auth-not-configured', 'invalid-request', 'unexpected', 'device-limit'] as const) expect(AUTH_MESSAGES[reason].length).toBeGreaterThan(10);
  });
  it('verificar código: sessão válida, limite de dispositivos com a lista, e corpo malformado', async () => {
    expect(await createAuthClient(BASE, reply(200, SESSION)).verifyCode({ email: 'bia@exemplo.com', code: '12345678' })).toEqual({ ok: true, value: SESSION });
    const limit = await createAuthClient(BASE, reply(409, { error: 'DEVICE_LIMIT', sessions: [{ id: 'ses_a', deviceLabel: 'Celular', createdAt: 'x', lastSeenAt: 'y' }] })).verifyCode({ email: 'a@b.com', code: '12345678' });
    expect(limit).toMatchObject({ ok: false, reason: 'device-limit', sessions: [{ id: 'ses_a', deviceLabel: 'Celular' }] });
    expect(await createAuthClient(BASE, reply(200, { user: {} })).verifyCode({ email: 'a@b.com', code: '12345678' })).toMatchObject({ ok: false, reason: 'unexpected' });
  });
  it('sessão atual, dispositivos, logout e remoção enviam o CSRF só nas operações que alteram', async () => {
    const f = reply(200, SESSION);
    const c = createAuthClient(BASE, f);
    expect(await c.currentSession()).toMatchObject({ ok: true });
    await c.logout('csrf-1'); await c.revokeSession('csrf-2', 'ses_0123456789abcdef'); await c.listSessions();
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u.replace(BASE, '')}`)).toEqual(['GET /api/auth/session', 'POST /api/auth/logout', 'DELETE /api/sessions/ses_0123456789abcdef', 'GET /api/sessions']);
    expect(calls.map(([, i]) => (i.headers as Record<string, string>)['X-CSRF-Token'])).toEqual([undefined, 'csrf-1', 'csrf-2', undefined]);
    expect(await createAuthClient(BASE, reply(401, {})).currentSession()).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await createAuthClient(BASE, reply(401, {})).logout('x')).toEqual({ ok: true, value: true }); // sessão já tinha acabado
  });
  it('não registra e-mail, código nem tokens em log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const c = createAuthClient(BASE, reply(200, SESSION));
    await c.requestCode('bia@exemplo.com'); await c.verifyCode({ email: 'bia@exemplo.com', code: '12345678' }); await c.logout('csrf');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('Cliente de autenticação contra o Worker real', () => {
  it('fluxo completo: pedir código, entrar, listar dispositivos, trocar o 3º dispositivo e sair', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.com');
    const entrar = async (label: string, replace?: string) => {
      const client = createAuthClient('https://api.exemplo.test', s.fetchFor());
      if (!replace) expect((await client.requestCode('bia@exemplo.com')).ok).toBe(true);
      return { client, r: await client.verifyCode({ email: 'bia@exemplo.com', code: s.mail.lastCode()!, deviceLabel: label, ...(replace ? { replaceSessionId: replace } : {}) }) };
    };
    const a = await entrar('Celular'); const b = await entrar('Notebook');
    expect(a.r.ok && b.r.ok).toBe(true);
    const third = await entrar('Tablet');
    expect(third.r).toMatchObject({ ok: false, reason: 'device-limit' });
    if (a.r.ok && third.r.ok === false && third.r.reason === 'device-limit') {
      expect(third.r.sessions.map(x => x.deviceLabel)).toEqual(['Celular', 'Notebook']);
      const again = await entrar('Tablet', third.r.sessions[0].id);
      expect(again.r.ok).toBe(true);
    }
  });
});
