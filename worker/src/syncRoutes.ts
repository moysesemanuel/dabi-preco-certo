import { SYNC_LIMITS } from '../../shared/sync';
import { apiError, json, readJsonBody, respond } from './http';
import { authorizeAccount, type SessionEnv } from './session';
import { parsePushRequest, pull, push } from './sync';
import { randomToken } from './accounts';

type Deps = { now: () => Date };

function failure(a: Extract<Awaited<ReturnType<typeof authorizeAccount>>, { ok: false }>): Response {
  return respond(JSON.stringify({ error: a.error, message: a.message }), a.status, 'application/json; charset=utf-8', a.retryAfterSeconds !== undefined ? { 'Retry-After': String(a.retryAfterSeconds) } : {});
}

/** GET /api/sync?since=N: alterações da conta com revisão maior que N (0 = tudo). */
export async function syncPull(request: Request, env: SessionEnv, deps: Deps): Promise<Response> {
  const auth = await authorizeAccount(request, env, deps.now(), { write: false });
  if (!auth.ok) return failure(auth);
  const raw = new URL(request.url).searchParams.get('since') ?? '0';
  const since = /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(since)) return apiError(400, 'INVALID_REQUEST', 'Parâmetro "since" inválido.');
  return json(await pull(env.DB, auth.userId, since, deps.now().toISOString()));
}

/** POST /api/sync/push: envia alterações de forma atômica; 409 CONFLICT/STALE se a conta mudou desde a revisão base. */
export async function syncPush(request: Request, env: SessionEnv, deps: Deps): Promise<Response> {
  const auth = await authorizeAccount(request, env, deps.now(), { write: true });
  if (!auth.ok) return failure(auth);
  const body = await readJsonBody(request, SYNC_LIMITS.maxBodyBytes);
  if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
  const parsed = parsePushRequest(body.data);
  if (typeof parsed === 'string') return apiError(400, 'INVALID_PAYLOAD', parsed);
  const out = await push(env.DB, auth.userId, parsed, deps.now().toISOString(), randomToken(16));
  return out.ok ? json(out.result) : json(out.body, out.status);
}
