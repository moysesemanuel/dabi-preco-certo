import type { PullResponse, PushRequest } from '../../shared/sync';
import { SyncError, type PushResponse, type SyncApi } from './engine';

type Options = {
  /** Origem do serviço (ex.: https://api.exemplo.com). */
  baseUrl: string;
  /** Token CSRF da sessão atual (vem de GET /api/auth/session). */
  getCsrfToken: () => string | undefined;
  fetchImpl?: typeof fetch;
};

/** Cliente HTTP da sincronização. A sessão vai no cookie HttpOnly (credentials: include); nunca há segredo em URL. */
export function createHttpSyncApi({ baseUrl, getCsrfToken, fetchImpl = fetch }: Options): SyncApi {
  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try { res = await fetchImpl(`${baseUrl}${path}`, { ...init, credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer' }); }
    catch { throw new SyncError('offline', 'Sem conexão com o servidor.'); }
    return res;
  }
  const messageOf = async (res: Response, fallback: string) => { try { const b = await res.json() as { message?: unknown }; return typeof b.message === 'string' ? b.message : fallback; } catch { return fallback; } };
  const fail = async (res: Response): Promise<never> => {
    if (res.status === 401) throw new SyncError('unauthorized', 'Sua sessão expirou. Entre novamente.');
    if (res.status === 403) throw new SyncError('forbidden', await messageOf(res, 'Acesso negado.'));
    if (res.status === 429) throw new SyncError('rate-limited', 'Muitas requisições. Tente novamente em instantes.');
    if (res.status === 400 || res.status === 413 || res.status === 422) throw new SyncError('rejected', await messageOf(res, 'O servidor recusou os dados.'));
    throw new SyncError('server', 'O servidor não respondeu como esperado.');
  };

  return {
    async pull(since: number): Promise<PullResponse> {
      const res = await call(`/api/sync?since=${since}`, { method: 'GET' });
      if (res.status !== 200) return fail(res);
      try { return await res.json() as PullResponse; } catch { throw new SyncError('server', 'Resposta inválida do servidor.'); }
    },
    async push(request: PushRequest): Promise<PushResponse> {
      const csrf = getCsrfToken();
      const res = await call('/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(request) });
      if (res.status === 200) { const b = await res.json() as { revision: number; changed: boolean }; return { ok: true, revision: b.revision, changed: b.changed }; }
      if (res.status === 409) { const b = await res.json().catch(() => ({})) as { error?: string }; return { ok: false, kind: b.error === 'STALE' ? 'stale' : 'conflict' }; }
      return fail(res);
    },
  };
}
