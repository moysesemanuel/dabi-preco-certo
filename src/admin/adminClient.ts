import { apiCall, field } from '../account/http';

export type AdminFailure = 'network' | 'unauthorized' | 'forbidden' | 'csrf' | 'rate-limited' | 'invalid' | 'not-found' | 'conflict' | 'unexpected';
export type AdminResult<T> = { ok: true; value: T } | { ok: false; reason: AdminFailure; retryAfter?: number };

export const ADMIN_MESSAGES: Record<AdminFailure, string> = {
  network: 'Sem conexão com o servidor. A ação NÃO foi confirmada; confira a lista antes de repetir.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
  forbidden: 'Esta conta não tem acesso administrativo.',
  csrf: 'Requisição recusada por segurança. Recarregue a página e tente de novo.',
  'rate-limited': 'Muitas requisições. Aguarde um instante.',
  invalid: 'Os dados informados não foram aceitos. Confira e tente de novo.',
  'not-found': 'Não encontrado (pode já ter sido alterado).',
  conflict: 'Esta ação não é permitida para contas administrativas.',
  unexpected: 'Resposta inesperada do servidor. Tente novamente mais tarde.',
};

export type Overview = { generatedAt: string; customers: { total: number; active: number; suspended: number; pendingFirstLogin: number; new30d: number }; activeSessions: number; recentUsers7d: number };
export type CustomerRow = { id: string; email: string; label: string | null; status: 'active' | 'revoked'; createdAt: string; suspendedAt: string | null; accountId: string | null; lastAccessAt: string | null; isAdmin: boolean; activeSessions: number };
export type CustomerDetail = { customer: Omit<CustomerRow, 'activeSessions'> & { quotaActive: number; quotaDaily: number; emailVerifiedAt: string | null; accountCreatedAt: string | null; accountDisabledAt: string | null }; sessions: { id: string; deviceLabel: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }[]; history: AuditEvent[]; historyHasMore: boolean };
export type AuditEvent = { id: number; at: string; action: string; result: string; detail: string | null; admin: string | null; licenseId: string | null; customerEmail: string | null };

/**
 * Cliente da API administrativa. A autorização é SEMPRE do servidor; este cliente só envia o cookie de sessão e o token CSRF.
 * Falha de rede nunca vira sucesso: devolve `network` e a tela diz que a ação não foi confirmada.
 */
export function createAdminClient(base: string, getCsrf: () => string | undefined, fetchImpl: typeof fetch = fetch) {
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, pick: (body: unknown) => T | undefined): Promise<AdminResult<T>> {
    const write = (init.method ?? 'GET') !== 'GET';
    const res = await apiCall(base, `/api/admin${path}`, { ...init, ...(write ? { csrf: getCsrf() } : {}) }, fetchImpl);
    if (!res) return { ok: false, reason: 'network' };
    const retry = res.retryAfter !== undefined ? { retryAfter: res.retryAfter } : {};
    if (res.status >= 200 && res.status < 300) { const v = pick(res.body); return v === undefined ? { ok: false, reason: 'unexpected' } : { ok: true, value: v }; }
    const err = field<string>(res.body, 'error');
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (res.status === 403) return { ok: false, reason: err === 'CSRF' ? 'csrf' : 'forbidden' };
    if (res.status === 429) return { ok: false, reason: 'rate-limited', ...retry };
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (res.status === 409) return { ok: false, reason: 'conflict' };
    if (res.status === 400 || res.status === 413) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unexpected' };
  }
  const whole = <T,>(b: unknown) => (b && typeof b === 'object' ? (b as T) : undefined);
  const qs = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
  return {
    me: () => call<{ email: string }>('/me', {}, b => (field<boolean>(b, 'admin') === true ? { email: field<string>(b, 'email') ?? '' } : undefined)),
    overview: () => call<Overview>('/overview', {}, whole<Overview>),
    customers: (o: { q?: string; status?: string; cursor?: string }) => call<{ customers: CustomerRow[]; nextCursor: string | null }>(`/customers${qs({ ...o, limit: '25' })}`, {}, whole),
    customer: (id: string) => call<CustomerDetail>(`/customers/${id}`, {}, whole),
    createCustomer: (b: { email: string; label?: string }) => call<{ created: boolean; id: string | null; email: string }>('/customers', { method: 'POST', body: b }, whole),
    suspend: (id: string, confirmEmail: string) => call<{ changed: boolean }>(`/customers/${id}/suspend`, { method: 'POST', body: { confirmEmail } }, whole),
    activate: (id: string) => call<{ changed: boolean }>(`/customers/${id}/activate`, { method: 'POST', body: {} }, whole),
    revokeSession: (id: string, sessionId: string) => call<{ revoked: string }>(`/customers/${id}/sessions/${sessionId}`, { method: 'DELETE' }, whole),
    revokeAll: (id: string, confirmEmail: string) => call<{ revoked: number }>(`/customers/${id}/sessions/revoke-all`, { method: 'POST', body: { confirmEmail } }, whole),
    audit: (o: { licenseId?: string; cursor?: string }) => call<{ events: AuditEvent[]; nextCursor: string | null }>(`/audit${qs({ ...o, limit: '25' })}`, {}, whole),
  };
}
export type AdminClient = ReturnType<typeof createAdminClient>;
