import { isLicenseKeyFormat } from '../../../shared/licenseKey';

/**
 * Cliente da licença de compartilhamento. É usado SOMENTE para recursos remotos de compartilhamento de orçamentos:
 * precificação, receitas e encomendas funcionam sem conexão e sem licença.
 * A chave vai apenas no cabeçalho Authorization (nunca em URL), para o endereço configurado, e não é registrada em log.
 */
export type Quotas = { active: { used: number; limit: number }; daily: { used: number; limit: number } };
export type LicenseCheck =
  | { state: 'valid'; licenseId: string; quotas: Quotas }
  | { state: 'invalid' }
  | { state: 'revoked' }
  | { state: 'rate-limited'; retryAfterSeconds?: number }
  | { state: 'error'; reason: 'not-configured' | 'bad-format' | 'network' | 'unexpected' };

/** Aceita https em qualquer host e http apenas em localhost, para não enviar a chave sem criptografia pela internet. */
export function safeApiBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return undefined;
    return u.origin;
  } catch { return undefined; }
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function readQuotas(value: unknown): Quotas | undefined {
  const q = value as { active?: { used?: unknown; limit?: unknown }; daily?: { used?: unknown; limit?: unknown } } | null;
  if (!q || !isCount(q.active?.used) || !isCount(q.active?.limit) || !isCount(q.daily?.used) || !isCount(q.daily?.limit)) return undefined;
  return { active: { used: q.active.used, limit: q.active.limit }, daily: { used: q.daily.used, limit: q.daily.limit } };
}

export async function verifyLicense(apiUrl: string | undefined, key: string, fetchImpl: typeof fetch = fetch): Promise<LicenseCheck> {
  const base = safeApiBase(apiUrl);
  if (!base) return { state: 'error', reason: 'not-configured' };
  const trimmed = key.trim();
  if (!isLicenseKeyFormat(trimmed)) return { state: 'error', reason: 'bad-format' };
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/license`, { method: 'GET', headers: { Authorization: `Bearer ${trimmed}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch { return { state: 'error', reason: 'network' }; }
  if (res.status === 401) return { state: 'invalid' };
  if (res.status === 403) return { state: 'revoked' };
  if (res.status === 429) { const retry = Number(res.headers.get('retry-after')); return { state: 'rate-limited', ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) }; }
  if (res.status !== 200) return { state: 'error', reason: 'unexpected' };
  try {
    const body = await res.json() as { status?: unknown; licenseId?: unknown; quotas?: unknown };
    const quotas = readQuotas(body.quotas);
    if (body.status === 'active' && typeof body.licenseId === 'string' && quotas) return { state: 'valid', licenseId: body.licenseId, quotas };
  } catch { /* cai no erro inesperado */ }
  return { state: 'error', reason: 'unexpected' };
}

/**
 * Armazenamento local da chave, fora do banco de dados do app (não entra nos backups).
 * ATENÇÃO: o armazenamento do navegador não protege contra quem tem acesso ao dispositivo/perfil nem contra scripts maliciosos.
 */
const STORAGE_KEY = 'pedidocerto.license.v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStorage = (): StorageLike | undefined => { try { return window.localStorage; } catch { return undefined; } };

export const licenseStorage = {
  get(storage: StorageLike | undefined = defaultStorage()): string | null {
    try { const v = storage?.getItem(STORAGE_KEY) ?? null; return v && isLicenseKeyFormat(v) ? v : null; } catch { return null; }
  },
  /** true se salvou. */
  set(key: string, storage: StorageLike | undefined = defaultStorage()): boolean {
    try { if (!storage || !isLicenseKeyFormat(key)) return false; storage.setItem(STORAGE_KEY, key); return true; } catch { return false; }
  },
  clear(storage: StorageLike | undefined = defaultStorage()): void { try { storage?.removeItem(STORAGE_KEY); } catch { /* sem armazenamento */ } },
};

/** Mostra só o início e o fim; nunca exibe a chave inteira depois de salva. */
export const maskLicenseKey = (key: string): string => `${key.slice(0, 9)}••••••••${key.slice(-4)}`;
