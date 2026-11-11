import { parseBearer } from '../../shared/licenseKey';
import { hashLicenseKey } from './licenses';
import { consumeRateLimit, getLicenseByHash, type D1Like } from './store';

export const DEFAULT_LIMITS = {
  /** Operações de escrita (criar, atualizar, revogar) por licença, por minuto. */
  writesPerMinute: 20,
  /** Verificações de licença (GET /api/license) por licença, por minuto. */
  verifyPerMinute: 30,
  /** Valores padrão de cota, usados quando o autorizador não informa os da licença. */
  quotaActive: 100,
  quotaDaily: 30,
} as const;

export type AuthScope = 'write' | 'verify';
export type AuthResult =
  | { ok: true; ownerId: string; limits?: { quotaActive: number; quotaDaily: number } }
  | { ok: false; status: 401 | 403 | 429 | 501; error: string; message: string; retryAfterSeconds?: number };
export type Authorizer = (request: Request, env: { DB: D1Like }, ctx: { scope: AuthScope; now: Date }) => Promise<AuthResult>;

const UNAUTHORIZED: AuthResult = { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Chave de licença ausente ou inválida.' };

/**
 * Autoriza pela chave de licença enviada em `Authorization: Bearer <chave>` (nunca em URL).
 * Ordem: formato da chave (barato, sem tocar no banco) → licença existe → não revogada → limite de taxa.
 * Ausente, malformada e desconhecida respondem igual (401), para não revelar o que existe.
 * Esta função nunca registra a chave em log nem a devolve em respostas.
 */
export function createLicenseAuthorizer(opts: { writesPerMinute?: number; verifyPerMinute?: number } = {}): Authorizer {
  const perMinute = { write: opts.writesPerMinute ?? DEFAULT_LIMITS.writesPerMinute, verify: opts.verifyPerMinute ?? DEFAULT_LIMITS.verifyPerMinute };
  return async (request, env, { scope, now }) => {
    const key = parseBearer(request.headers.get('authorization'));
    if (!key) return UNAUTHORIZED;
    const license = await getLicenseByHash(env.DB, await hashLicenseKey(key));
    if (!license) return UNAUTHORIZED;
    if (license.status !== 'active') return { ok: false, status: 403, error: 'LICENSE_REVOKED', message: 'Esta licença foi revogada. Entre em contato com o suporte.' };
    const rate = await consumeRateLimit(env.DB, license.id, scope, perMinute[scope], 60, now.getTime());
    if (!rate.allowed) return { ok: false, status: 429, error: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um instante e tente novamente.', retryAfterSeconds: rate.retryAfterSeconds };
    return { ok: true, ownerId: license.id, limits: { quotaActive: license.quota_active, quotaDaily: license.quota_daily } };
  };
}
