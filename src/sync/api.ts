import { SYNC_PATHS, SYNC_PROTOCOL, type PullResponse, type PushRequest } from '../../shared/sync';
import { SyncError, type PushResponse, type SyncApi } from './engine';

type Options = {
  /** Origem do serviço (ex.: https://api.exemplo.com). */
  baseUrl: string;
  /** Token CSRF da sessão atual (vem de GET /api/auth/session). */
  getCsrfToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** Tempo máximo de cada requisição (padrão 20 s). */
  timeoutMs?: number;
};

/** Cliente HTTP da sincronização. A sessão vai no cookie HttpOnly (credentials: include); nunca há segredo em URL. */
const OUTDATED_MESSAGE = 'O servidor ainda não suporta encomendas com vários produtos. Seus dados continuam neste dispositivo e serão enviados quando o servidor for atualizado.';

export function createHttpSyncApi({ baseUrl, getCsrfToken, fetchImpl = fetch, timeoutMs = 20_000 }: Options): SyncApi {
  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    // Sem limite de tempo, uma requisição que nunca responde deixaria a sincronização presa para sempre.
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: ctl.signal, credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer' }); }
    catch { throw new SyncError('offline', ctl.signal.aborted ? 'O servidor não respondeu a tempo.' : 'Sem conexão com o servidor.'); }
    finally { clearTimeout(timer); }
    return res;
  }
  const messageOf = async (res: Response, fallback: string) => { try { const b = await res.json() as { message?: unknown }; return typeof b.message === 'string' ? b.message : fallback; } catch { return fallback; } };
  const fail = async (res: Response): Promise<never> => {
    if (res.status === 401) throw new SyncError('unauthorized', 'Sua sessão expirou. Entre novamente.');
    if (res.status === 403) throw new SyncError('forbidden', await messageOf(res, 'Acesso negado.'));
    // 404/426 nas rotas de sincronização = servidor e app em versões incompatíveis. Nada é enviado nem apagado; os dados ficam aqui.
    if (res.status === 404 || res.status === 426) throw new SyncError('outdated', OUTDATED_MESSAGE);
    if (res.status === 429) throw new SyncError('rate-limited', 'Muitas requisições. Tente novamente em instantes.');
    if (res.status === 400 || res.status === 413 || res.status === 422) throw new SyncError('rejected', await messageOf(res, 'O servidor recusou os dados.'));
    throw new SyncError('server', 'O servidor não respondeu como esperado.');
  };

  return {
    async pull(since: number): Promise<PullResponse> {
      const res = await call(`${SYNC_PATHS.pull}?since=${since}`, { method: 'GET' });
      if (res.status !== 200) return fail(res);
      let body: PullResponse;
      try { body = await res.json() as PullResponse; } catch { throw new SyncError('server', 'Resposta inválida do servidor.'); }
      // Um servidor que não declara o protocolo atual não entende itens: nada dele é aplicado (evita perder itens locais).
      if (body?.protocol !== SYNC_PROTOCOL) throw new SyncError('outdated', OUTDATED_MESSAGE);
      return body;
    },
    async push(request: PushRequest): Promise<PushResponse> {
      const csrf = getCsrfToken();
      const res = await call(SYNC_PATHS.push, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: JSON.stringify(request) });
      if (res.status === 200) { const b = await res.json() as { revision: number; changed: boolean }; return { ok: true, revision: b.revision, changed: b.changed }; }
      if (res.status === 409) {
        const b = await res.json().catch(() => ({})) as { error?: string; orderIds?: unknown };
        if (b.error === 'CODE_TAKEN') return { ok: false, kind: 'code', orderIds: Array.isArray(b.orderIds) ? b.orderIds.filter((x): x is string => typeof x === 'string') : [] };
        return { ok: false, kind: b.error === 'STALE' ? 'stale' : 'conflict' };
      }
      return fail(res);
    },
  };
}
