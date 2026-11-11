import { addMs, CODE_DIGITS, CODE_RESEND_COOLDOWN_SECONDS, CODE_TTL_MINUTES, generateNumericCode, hmacHex, MAX_SESSIONS, newCodeId, newSessionId, newUserId, normalizeDeviceLabel, normalizeEmail, randomToken, sha256Hex, timingSafeEqual } from './accounts';
import {
  bindLicenseToUser, claimAttempt, createVerifiedUser, discardCode, findUserByEmail, insertSessionWithinLimit, latestOpenCode, licenseForEmail,
  listActiveSessions, markCodeUsed, recentOpenCode, replaceCode, revokeSession, type AccountLicense, type SessionRow,
} from './accountStore';
import { EmailSendError, type EmailSender } from './email';
import { loginCodeEmail } from './emailTemplates';
import { apiError, json, readJsonBody, respond } from './http';
import { checkCsrf, clearSessionCookie, resolveSession, sessionCookie, sessionIdleMs, sessionMaxAgeSeconds, type SessionEnv } from './session';
import { consumeRateLimit } from './store';

export type AuthEnv = SessionEnv & { AUTH_SECRET?: string };
export type AuthDeps = { now: () => Date; email: (env: AuthEnv) => EmailSender };

/** Limites por hora. A defesa principal é POR E-MAIL (e por código); o limite por IP é só uma rede de proteção ampla (30/60 por hora), nunca o único bloqueio. */
export const LOGIN_LIMITS = { requestPerEmail: 5, requestPerIp: 30, verifyPerEmail: 15, verifyPerIp: 60 } as const;
const HOUR = 3600;
const ID_SESSION = /^ses_[0-9a-f]{16}$/;

const ipOf = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';
const tooMany = (retryAfterSeconds: number) => respond(JSON.stringify({ error: 'RATE_LIMITED', message: 'Muitas tentativas. Aguarde um pouco e tente novamente.' }), 429, 'application/json; charset=utf-8', { 'Retry-After': String(retryAfterSeconds) });

async function throttle(env: AuthEnv, request: Request, now: Date, scope: 'login-request' | 'login-verify', email: string): Promise<Response | null> {
  const limits = scope === 'login-request' ? [LOGIN_LIMITS.requestPerEmail, LOGIN_LIMITS.requestPerIp] : [LOGIN_LIMITS.verifyPerEmail, LOGIN_LIMITS.verifyPerIp];
  const [byEmail, byIp] = await Promise.all([sha256Hex(`email:${email}`), sha256Hex(`ip:${ipOf(request)}`)]);
  const a = await consumeRateLimit(env.DB, `e_${byEmail}`, scope, limits[0], HOUR, now.getTime());
  if (!a.allowed) return tooMany(a.retryAfterSeconds);
  const b = await consumeRateLimit(env.DB, `i_${byIp}`, scope, limits[1], HOUR, now.getTime());
  return b.allowed ? null : tooMany(b.retryAfterSeconds);
}

const publicSession = (s: SessionRow, currentId?: string) => ({ id: s.id, deviceLabel: s.device_label, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === currentId });
const publicLicense = (l: AccountLicense | null) => (l ? { status: l.status, quotaActive: l.quota_active, quotaDaily: l.quota_daily } : null);

/** POST /api/auth/request-code: envia um código de acesso de 8 dígitos. A resposta é igual exista ou não uma conta (não revela cadastros). */
export async function requestCode(request: Request, env: AuthEnv, deps: AuthDeps): Promise<Response> {
  if (!env.AUTH_SECRET) return apiError(503, 'AUTH_NOT_CONFIGURED', 'A autenticação não está configurada neste ambiente.');
  const sender = deps.email(env);
  if (!sender.configured) return apiError(503, 'EMAIL_NOT_CONFIGURED', 'O envio de e-mail não está configurado neste ambiente.');
  const body = await readJsonBody(request, 2048);
  if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
  const email = normalizeEmail((body.data as { email?: unknown } | null)?.email);
  if (!email) return apiError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
  const now = deps.now();
  const limited = await throttle(env, request, now, 'login-request', email);
  if (limited) return limited;

  const ok = () => json({ ok: true, expiresInMinutes: CODE_TTL_MINUTES }, 202);
  const license = await licenseForEmail(env.DB, email);
  if (!license || license.status !== 'active') return ok(); // sem conta/licença: mesma resposta, nenhum e-mail

  const iso = now.toISOString();
  // Intervalo mínimo: um segundo clique (ou um robô) não gera outro e-mail nem invalida o código que acabou de ser enviado.
  if (await recentOpenCode(env.DB, email, addMs(iso, -CODE_RESEND_COOLDOWN_SECONDS * 1000), iso)) return ok();
  const code = generateNumericCode();
  const row = { id: newCodeId(), email, code_hash: await hmacHex(env.AUTH_SECRET, `${email}|${code}`), created_at: iso, expires_at: addMs(iso, CODE_TTL_MINUTES * 60_000), attempts: 0, used_at: null };
  await replaceCode(env.DB, row, iso);
  try {
    await sender.send({ to: email, ...loginCodeEmail(code, CODE_TTL_MINUTES) });
  } catch (e) {
    await discardCode(env.DB, row.id, iso); // não deixa um código válido que ninguém recebeu
    const retry = e instanceof EmailSendError ? e.retryAfterSeconds : undefined; // limite do provedor: repassa o tempo de espera
    return apiError(503, 'EMAIL_SEND_FAILED', 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.', retry ? { 'Retry-After': String(retry) } : {});
  }
  return ok();
}

/**
 * POST /api/auth/verify-code: confere o código (máx. 5 tentativas por código, uso único), cria a conta no primeiro acesso
 * e abre uma sessão. Com 2 sessões ativas devolve 409 com a lista; reenvie com `replaceSessionId` para trocar uma.
 */
export async function verifyCode(request: Request, env: AuthEnv, deps: AuthDeps): Promise<Response> {
  if (!env.AUTH_SECRET) return apiError(503, 'AUTH_NOT_CONFIGURED', 'A autenticação não está configurada neste ambiente.');
  const body = await readJsonBody(request, 2048);
  if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
  const b = (body.data ?? {}) as { email?: unknown; code?: unknown; deviceLabel?: unknown; replaceSessionId?: unknown };
  const email = normalizeEmail(b.email);
  if (!email || typeof b.code !== 'string' || !new RegExp(`^\\d{${CODE_DIGITS}}$`).test(b.code)) return apiError(400, 'INVALID_REQUEST', 'Informe o e-mail e o código de 8 dígitos.');
  if (b.replaceSessionId !== undefined && (typeof b.replaceSessionId !== 'string' || !ID_SESSION.test(b.replaceSessionId))) return apiError(400, 'INVALID_REQUEST', 'Sessão a substituir inválida.');
  const now = deps.now();
  const iso = now.toISOString();
  const limited = await throttle(env, request, now, 'login-verify', email);
  if (limited) return limited;

  const wrong = () => apiError(401, 'INVALID_CODE', 'Código inválido ou expirado.');
  const open = await latestOpenCode(env.DB, email, iso);
  if (!open || !(await claimAttempt(env.DB, open.id, iso))) return wrong();
  if (!timingSafeEqual(await hmacHex(env.AUTH_SECRET, `${email}|${b.code}`), open.code_hash)) return wrong();

  const license = await licenseForEmail(env.DB, email);
  if (!license || license.status !== 'active') return apiError(403, 'NO_ACTIVE_LICENSE', 'Não há licença ativa para este e-mail.');
  let user = await findUserByEmail(env.DB, email);
  if (!user) { await createVerifiedUser(env.DB, newUserId(), email, iso); user = await findUserByEmail(env.DB, email); }
  if (!user || user.disabled_at) return apiError(403, 'ACCOUNT_DISABLED', 'Esta conta está desativada.');
  if (license.user_id && license.user_id !== user.id) return apiError(403, 'NO_ACTIVE_LICENSE', 'Não há licença ativa para este e-mail.');

  const active = await listActiveSessions(env.DB, user.id, iso);
  const limitReached = () => json({ error: 'DEVICE_LIMIT', message: `Esta conta já está em ${MAX_SESSIONS} dispositivos. Escolha um para desconectar.`, sessions: active.map(s => publicSession(s)) }, 409);
  const replace = b.replaceSessionId as string | undefined;
  if (active.length >= MAX_SESSIONS && !replace) return limitReached(); // o código continua válido para a nova tentativa
  if (replace && !active.some(s => s.id === replace)) return apiError(400, 'INVALID_REQUEST', 'A sessão escolhida não existe ou já foi encerrada.');
  // O código é consumido ANTES de encerrar a sessão escolhida: uma requisição repetida/simultânea que perca a disputa não derruba
  // o dispositivo de ninguém sem abrir a sessão nova.
  if (!(await markCodeUsed(env.DB, open.id, iso))) return wrong(); // uso único, mesmo com requisições simultâneas
  if (replace) await revokeSession(env.DB, user.id, replace, iso);
  if (!license.user_id) await bindLicenseToUser(env.DB, license.id, user.id);

  const token = randomToken(32);
  const sessionId = newSessionId();
  const csrf = randomToken(24);
  const created = await insertSessionWithinLimit(env.DB, { id: sessionId, user_id: user.id, token_hash: await sha256Hex(token), csrf_token: csrf, device_label: normalizeDeviceLabel(b.deviceLabel), created_at: iso, last_seen_at: iso, expires_at: addMs(iso, sessionIdleMs) }, iso, MAX_SESSIONS);
  if (!created) return limitReached();
  const res = json({ user: { id: user.id, email: user.email }, csrfToken: csrf, sessionId, license: publicLicense(license) });
  res.headers.append('Set-Cookie', sessionCookie(request, token, sessionMaxAgeSeconds));
  return res;
}

/** GET /api/auth/session: quem está logado (e o token CSRF da sessão). */
export async function currentSession(request: Request, env: AuthEnv, deps: AuthDeps): Promise<Response> {
  const r = await resolveSession(request, env, deps.now());
  if (!r.ok) return apiError(r.status, r.error, r.message);
  const { user, session, license } = r.ctx;
  return json({ user: { id: user.id, email: user.email }, csrfToken: session.csrf_token, sessionId: session.id, license: publicLicense(license) });
}

/** POST /api/auth/logout: encerra a sessão atual. */
export async function logout(request: Request, env: AuthEnv, deps: AuthDeps): Promise<Response> {
  const r = await resolveSession(request, env, deps.now());
  if (!r.ok) return apiError(r.status, r.error, r.message);
  const csrf = checkCsrf(request, env, r.ctx.session);
  if (csrf) return apiError(csrf.status, csrf.error, csrf.message);
  await revokeSession(env.DB, r.ctx.user.id, r.ctx.session.id, deps.now().toISOString());
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie(request));
  return res;
}

/** GET /api/sessions: dispositivos autorizados da própria conta. */
export async function sessionsList(request: Request, env: AuthEnv, deps: AuthDeps): Promise<Response> {
  const r = await resolveSession(request, env, deps.now());
  if (!r.ok) return apiError(r.status, r.error, r.message);
  const list = await listActiveSessions(env.DB, r.ctx.user.id, deps.now().toISOString());
  return json({ maxSessions: MAX_SESSIONS, sessions: list.map(s => publicSession(s, r.ctx.session.id)) });
}

/** DELETE /api/sessions/:id: remove um dispositivo da PRÓPRIA conta (outra conta recebe 404). */
export async function sessionRevoke(request: Request, env: AuthEnv, deps: AuthDeps, sessionId: string): Promise<Response> {
  const r = await resolveSession(request, env, deps.now());
  if (!r.ok) return apiError(r.status, r.error, r.message);
  const csrf = checkCsrf(request, env, r.ctx.session);
  if (csrf) return apiError(csrf.status, csrf.error, csrf.message);
  if (!ID_SESSION.test(sessionId) || !(await revokeSession(env.DB, r.ctx.user.id, sessionId, deps.now().toISOString()))) return apiError(404, 'NOT_FOUND', 'Dispositivo não encontrado.');
  const res = json({ ok: true, revoked: sessionId });
  if (sessionId === r.ctx.session.id) res.headers.append('Set-Cookie', clearSessionCookie(request));
  return res;
}
