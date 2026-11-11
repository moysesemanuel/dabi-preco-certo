import { sha256Hex, timingSafeEqual, SESSION_TTL_DAYS } from './accounts';
import { getSessionByTokenHash, licenseForUser, findUserById, touchSession, type AccountLicense, type SessionRow, type UserRow } from './accountStore';
import { DEFAULT_LIMITS, type Authorizer } from './auth';
import { consumeRateLimit, type D1Like } from './store';

export type SessionEnv = { DB: D1Like; ALLOWED_ORIGINS?: string };
const SECURE_COOKIE = '__Host-dabi_session';
const PLAIN_COOKIE = 'dabi_session';
const TOUCH_AFTER_MS = 3600_000;

const isHttps = (request: Request) => new URL(request.url).protocol === 'https:';
/** Em https o cookie usa o prefixo __Host- (Secure, sem Domain, Path=/); em http (localhost, desenvolvimento) não é possível ser Secure. */
export const sessionCookieName = (request: Request) => (isHttps(request) ? SECURE_COOKIE : PLAIN_COOKIE);

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
export const hasSessionCookie = (request: Request) => readCookie(request, sessionCookieName(request)) !== undefined;

/** Cookie HttpOnly (JavaScript não lê), SameSite=Lax e, em https, Secure. */
export function sessionCookie(request: Request, token: string, maxAgeSeconds: number): string {
  return `${sessionCookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isHttps(request) ? '; Secure' : ''}`;
}
export const clearSessionCookie = (request: Request) => sessionCookie(request, '', 0);
export const sessionMaxAgeSeconds = SESSION_TTL_DAYS * 86_400;

export type SessionFailure = { ok: false; status: 401 | 403; error: string; message: string };
export type SessionContext = { session: SessionRow; user: UserRow; license: AccountLicense | null };
const invalid: SessionFailure = { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Sessão ausente, expirada ou revogada. Entre novamente.' };

export async function resolveSession(request: Request, env: SessionEnv, now: Date): Promise<{ ok: true; ctx: SessionContext } | SessionFailure> {
  const token = readCookie(request, sessionCookieName(request));
  if (!token || token.length < 20 || token.length > 128) return invalid;
  const session = await getSessionByTokenHash(env.DB, await sha256Hex(token));
  const iso = now.toISOString();
  if (!session || session.revoked_at || session.expires_at <= iso) return invalid;
  const user = await findUserById(env.DB, session.user_id);
  if (!user || user.disabled_at) return invalid;
  if (now.getTime() - new Date(session.last_seen_at).getTime() > TOUCH_AFTER_MS) await touchSession(env.DB, session.id, iso);
  return { ok: true, ctx: { session, user, license: await licenseForUser(env.DB, user.id) } };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Proteção CSRF para operações que alteram dados com autenticação por cookie:
 * (1) a requisição precisa vir de uma origem autorizada (cabeçalho Origin) e (2) trazer o token da sessão em X-CSRF-Token.
 * Um site malicioso não consegue nenhum dos dois, pois não lê o token (CORS) e sua origem não está autorizada.
 */
export function checkCsrf(request: Request, env: { ALLOWED_ORIGINS?: string }, session: SessionRow): SessionFailure | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  const token = request.headers.get('x-csrf-token');
  if (!origin || !allowed.includes(origin) || !token || !timingSafeEqual(token, session.csrf_token)) {
    return { ok: false, status: 403, error: 'CSRF', message: 'Requisição recusada por segurança. Recarregue a página e tente de novo.' };
  }
  return null;
}

/** Autorizador por sessão: cookie válido + CSRF + licença ativa da conta + limite de taxa. O dono dos orçamentos é a licença da conta. */
export function createSessionAuthorizer(opts: { writesPerMinute?: number; verifyPerMinute?: number } = {}): Authorizer {
  const perMinute = { write: opts.writesPerMinute ?? DEFAULT_LIMITS.writesPerMinute, verify: opts.verifyPerMinute ?? DEFAULT_LIMITS.verifyPerMinute };
  return async (request, env, { scope, now }) => {
    const e = env as SessionEnv;
    const r = await resolveSession(request, e, now);
    if (!r.ok) return r;
    const csrf = checkCsrf(request, e, r.ctx.session);
    if (csrf) return csrf;
    const license = r.ctx.license;
    if (!license) return { ok: false, status: 403, error: 'NO_ACTIVE_LICENSE', message: 'Esta conta não tem licença ativa.' };
    if (license.status !== 'active') return { ok: false, status: 403, error: 'LICENSE_REVOKED', message: 'A licença desta conta foi revogada. Entre em contato com o suporte.' };
    const rate = await consumeRateLimit(env.DB, license.id, scope, perMinute[scope], 60, now.getTime());
    if (!rate.allowed) return { ok: false, status: 429, error: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um instante e tente novamente.', retryAfterSeconds: rate.retryAfterSeconds };
    return { ok: true, ownerId: license.id, limits: { quotaActive: license.quota_active, quotaDaily: license.quota_daily } };
  };
}

/**
 * Autorizador combinado. Com cookie de sessão, usa a sessão. A chave de licença antiga (Bearer) só vale se
 * `LEGACY_KEY_AUTH=on`; por padrão está DESLIGADA, e a chave nunca é o fator de autenticação permanente.
 */
export function createCompositeAuthorizer(legacy: Authorizer, session: Authorizer = createSessionAuthorizer()): Authorizer {
  return async (request, env, ctx) => {
    if (hasSessionCookie(request)) return session(request, env, ctx);
    if ((env as { LEGACY_KEY_AUTH?: string }).LEGACY_KEY_AUTH === 'on' && request.headers.get('authorization')) return legacy(request, env, ctx);
    return { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Autenticação necessária.' };
  };
}
