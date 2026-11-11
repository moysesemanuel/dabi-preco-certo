import { createLicenseAuthorizer } from '../../worker/src/auth';
import { MemoryEmailSender } from '../../worker/src/email';
import { createHandler, type Env } from '../../worker/src/index';
import { issueLicenseSql } from '../../worker/src/licenseAdmin';
import { generateLicenseId, generateLicenseKey, hashLicenseKey } from '../../worker/src/licenses';
import { createCompositeAuthorizer, createSessionAuthorizer } from '../../worker/src/session';
import { createTestD1 } from './d1';

export const BASE = 'https://api.exemplo.test';
export const ORIGIN = 'http://localhost:5174';
export const SECRET = 'segredo-de-teste-que-so-existe-no-ambiente-de-teste';

export type Session = { cookie: string; csrf: string; sessionId: string };

/** Servidor de teste completo (Worker real + SQLite com as migrações reais) com contas, e-mail em memória e relógio controlável. */
export function makeServer(start = new Date('2026-11-12T15:00:00Z')) {
  const db = createTestD1();
  const mail = new MemoryEmailSender();
  const state = { clock: new Date(start) };
  const env: Env = { DB: db.d1, PUBLIC_BASE_URL: BASE, ALLOWED_ORIGINS: ORIGIN, AUTH_SECRET: SECRET };
  const handle = createHandler({ authorize: createCompositeAuthorizer(createLicenseAuthorizer(), createSessionAuthorizer({ writesPerMinute: 10_000, verifyPerMinute: 10_000 })), now: () => state.clock, email: () => mail });

  async function issueFor(email: string) {
    const id = generateLicenseId();
    db.raw.exec(issueLicenseSql({ id, keyHash: await hashLicenseKey(generateLicenseKey()), email, quotaActive: 100, quotaDaily: 30, now: state.clock.toISOString() }));
    return id;
  }
  const request = (method: string, path: string, o: { body?: unknown; session?: Session; origin?: string | null; ip?: string } = {}) => handle(new Request(`${BASE}${path}`, {
    method,
    headers: { ...(o.session ? { cookie: o.session.cookie, 'x-csrf-token': o.session.csrf } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), env);
  async function login(email: string, label = 'Dispositivo', ip?: string): Promise<Session> {
    await request('POST', '/api/auth/request-code', { body: { email }, ip });
    const res = await request('POST', '/api/auth/verify-code', { body: { email, code: mail.lastCode(), deviceLabel: label }, ip });
    if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${await res.text()}`);
    const body = await res.json() as { csrfToken: string; sessionId: string };
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken, sessionId: body.sessionId };
  }
  /** `fetch` que entrega as requisições direto ao Worker de teste, levando o cookie e a origem do app (como o navegador faria). */
  const fetchFor = (session?: Session): typeof fetch => (async (url: string, init: RequestInit = {}) =>
    handle(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...(session ? { cookie: session.cookie } : {}), origin: ORIGIN } }), env)) as typeof fetch;
  return { db, env, mail, state, handle, issueFor, request, login, fetchFor, table: (name: string) => db.raw.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[] };
}
export type Server = ReturnType<typeof makeServer>;
