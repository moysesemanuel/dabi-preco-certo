import { apiCall, field } from './http';

export type LicenseInfo = { status: 'active' | 'revoked'; quotaActive: number; quotaDaily: number };
export type SessionInfo = { user: { id: string; email: string }; csrfToken: string; sessionId: string; license: LicenseInfo | null };
export type DeviceInfo = { id: string; deviceLabel: string | null; createdAt: string; lastSeenAt: string; current?: boolean };
export type AuthFailure = 'network' | 'invalid-code' | 'rate-limited' | 'no-license' | 'unauthorized' | 'email-not-configured' | 'auth-not-configured' | 'invalid-request' | 'unexpected';
export type AuthResult<T> = ({ ok: true; value: T }) | { ok: false; reason: AuthFailure; retryAfter?: number } | (T extends SessionInfo ? { ok: false; reason: 'device-limit'; sessions: DeviceInfo[] } : never);

const isSession = (b: unknown): b is SessionInfo => !!b && typeof b === 'object' && typeof (b as SessionInfo).csrfToken === 'string' && typeof (b as SessionInfo).sessionId === 'string' && typeof (b as SessionInfo).user?.email === 'string';

function failure(res: { status: number; body: unknown; retryAfter?: number }): { ok: false; reason: AuthFailure; retryAfter?: number } {
  const code = field<string>(res.body, 'error');
  const retry = res.retryAfter !== undefined ? { retryAfter: res.retryAfter } : {};
  if (res.status === 429) return { ok: false, reason: 'rate-limited', ...retry };
  if (res.status === 401) return { ok: false, reason: code === 'INVALID_CODE' ? 'invalid-code' : 'unauthorized' };
  if (res.status === 403) return { ok: false, reason: code === 'NO_ACTIVE_LICENSE' || code === 'LICENSE_REVOKED' ? 'no-license' : 'unauthorized' };
  if (res.status === 503) return { ok: false, reason: code === 'EMAIL_NOT_CONFIGURED' || code === 'EMAIL_SEND_FAILED' ? 'email-not-configured' : 'auth-not-configured' };
  if (res.status === 400) return { ok: false, reason: 'invalid-request' };
  return { ok: false, reason: 'unexpected' };
}

export function createAuthClient(base: string, fetchImpl: typeof fetch = fetch) {
  return {
    /** Pede o código por e-mail. A resposta é a mesma exista ou não conta (o app não confirma se o e-mail tem licença). */
    async requestCode(email: string): Promise<AuthResult<{ expiresInMinutes: number }>> {
      const res = await apiCall(base, '/api/auth/request-code', { method: 'POST', body: { email } }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 202 ? { ok: true, value: { expiresInMinutes: field<number>(res.body, 'expiresInMinutes') ?? 10 } } : failure(res);
    },
    async verifyCode(args: { email: string; code: string; deviceLabel?: string; replaceSessionId?: string }): Promise<AuthResult<SessionInfo>> {
      const res = await apiCall(base, '/api/auth/verify-code', { method: 'POST', body: args }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      if (res.status === 200 && isSession(res.body)) return { ok: true, value: res.body };
      if (res.status === 409 && field<string>(res.body, 'error') === 'DEVICE_LIMIT') return { ok: false, reason: 'device-limit', sessions: field<DeviceInfo[]>(res.body, 'sessions') ?? [] };
      return failure(res);
    },
    /** Quem está logado neste navegador (o cookie HttpOnly vai sozinho). 401 = ninguém. */
    async currentSession(): Promise<AuthResult<SessionInfo>> {
      const res = await apiCall(base, '/api/auth/session', {}, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 && isSession(res.body) ? { ok: true, value: res.body } : failure(res);
    },
    async logout(csrf: string): Promise<AuthResult<true>> {
      const res = await apiCall(base, '/api/auth/logout', { method: 'POST', csrf }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 || res.status === 401 ? { ok: true, value: true } : failure(res); // 401: a sessão já tinha acabado
    },
    async listSessions(): Promise<AuthResult<DeviceInfo[]>> {
      const res = await apiCall(base, '/api/sessions', {}, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 ? { ok: true, value: field<DeviceInfo[]>(res.body, 'sessions') ?? [] } : failure(res);
    },
    async revokeSession(csrf: string, id: string): Promise<AuthResult<true>> {
      const res = await apiCall(base, `/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', csrf }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 ? { ok: true, value: true } : failure(res);
    },
  };
}
export type AuthClient = ReturnType<typeof createAuthClient>;

export const AUTH_MESSAGES: Record<AuthFailure | 'device-limit', string> = {
  network: 'Sem conexão com o servidor. Verifique a internet e tente de novo.',
  'invalid-code': 'Código inválido ou expirado. Peça um novo código.',
  'rate-limited': 'Muitas tentativas. Aguarde um pouco e tente novamente.',
  'no-license': 'Não há licença ativa para este e-mail.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
  'email-not-configured': 'O envio de e-mail não está disponível neste ambiente.',
  'auth-not-configured': 'O login não está configurado neste ambiente.',
  'invalid-request': 'Confira o e-mail e o código informados.',
  unexpected: 'Resposta inesperada do servidor. Tente novamente mais tarde.',
  'device-limit': 'Esta conta já está em 2 dispositivos.',
};
