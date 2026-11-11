/** Configuração e chamadas HTTP da conta. A sessão vai no cookie HttpOnly (nunca em URL nem em armazenamento do navegador). */
export const API_URL: string | undefined = import.meta.env.VITE_API_URL ?? import.meta.env.VITE_QUOTES_API_URL;

/** Versão comercial: o app só abre depois do login com licença ativa. Os dados locais existentes NUNCA são apagados por isso. */
export const REQUIRE_LOGIN: boolean = import.meta.env.VITE_REQUIRE_LOGIN === 'on';

/** Aceita https em qualquer host e http apenas em localhost/127.0.0.1, para não enviar a sessão sem criptografia pela internet. */
export function safeApiBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    // `same-origin`: a API é servida na MESMA origem do app (proxy do Vite em desenvolvimento, ou rota do próprio site). O cookie de
    // sessão fica no mesmo site do app, sem depender de cookies entre sites. Vale a mesma regra de https/localhost.
    const u = url.trim() === 'same-origin' ? new URL(window.location.origin) : new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return undefined;
    return u.origin;
  } catch { return undefined; }
}

export type ApiResponse = { status: number; body: unknown; retryAfter?: number };
/** Faz a chamada e devolve status + JSON. Erro de rede vira `null` (o chamador mostra "sem conexão"). */
export async function apiCall(base: string, path: string, init: { method?: string; body?: unknown; csrf?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<ApiResponse | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: init.method ?? 'GET', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.csrf ? { 'X-CSRF-Token': init.csrf } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch { return null; }
  const retry = Number(res.headers.get('retry-after'));
  let body: unknown = null;
  try { body = await res.json(); } catch { /* corpo vazio ou inválido */ }
  return { status: res.status, body, ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}) };
}
export const field = <T,>(body: unknown, key: string): T | undefined => (body && typeof body === 'object' ? ((body as Record<string, unknown>)[key] as T | undefined) : undefined);
