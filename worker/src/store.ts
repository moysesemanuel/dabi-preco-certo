/** Interface mínima do D1 usada aqui (compatível com D1Database do Cloudflare e com o simulador dos testes). */
export interface BoundStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
  /** Executa as instruções em UMA transação: ou todas valem, ou nenhuma (como D1Database.batch). */
  batch(statements: BoundStatement[]): Promise<{ meta: { changes?: number } }[]>;
}

export type QuoteRow = { id: string; payload: string; created_at: string; updated_at: string; revoked_at: string | null; owner_id: string | null };

/** Identificador público: 16 bytes aleatórios (128 bits) em base64url, 22 caracteres. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Todas as consultas usam parâmetros (bind); nenhum valor é concatenado no SQL.
export const getQuote = (db: D1Like, id: string) =>
  db.prepare('SELECT id, payload, created_at, updated_at, revoked_at, owner_id FROM quotes WHERE id = ?').bind(id).first<QuoteRow>();

export async function insertQuote(db: D1Like, row: { id: string; payload: string; now: string; ownerId: string }): Promise<void> {
  await db.prepare('INSERT INTO quotes (id, payload, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?)').bind(row.id, row.payload, row.now, row.now, row.ownerId).run();
}

export async function updateQuotePayload(db: D1Like, id: string, ownerId: string, payload: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE quotes SET payload = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(payload, now, id, ownerId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function revokeQuote(db: D1Like, id: string, ownerId: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE quotes SET revoked_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(now, now, id, ownerId).run();
  return (r.meta.changes ?? 0) > 0;
}

// ---- Licenças, limitação de taxa e cotas ----
export type LicenseRow = { id: string; key_hash: string; label: string | null; status: 'active' | 'revoked'; quota_active: number; quota_daily: number; created_at: string; revoked_at: string | null };

export const getLicenseByHash = (db: D1Like, keyHash: string) =>
  db.prepare('SELECT id, key_hash, label, status, quota_active, quota_daily, created_at, revoked_at FROM licenses WHERE key_hash = ?').bind(keyHash).first<LicenseRow>();

/**
 * Conta uma operação na janela atual de forma ATÔMICA (um único UPSERT): se o contador já atingiu o limite,
 * a cláusula WHERE impede o incremento e nenhuma linha é devolvida. Requisições concorrentes não ultrapassam o limite.
 */
export async function consumeRateLimit(db: D1Like, licenseId: string, scope: string, limit: number, windowSeconds: number, nowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = nowSec - (nowSec % windowSeconds);
  const row = await db.prepare(
    `INSERT INTO rate_limits (license_id, scope, window_start, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (license_id, scope, window_start) DO UPDATE SET count = count + 1 WHERE count < ?4
     RETURNING count`,
  ).bind(licenseId, scope, windowStart, limit).first<{ count: number }>();
  if (row && row.count === 1) await db.prepare('DELETE FROM rate_limits WHERE license_id = ?1 AND window_start < ?2').bind(licenseId, windowStart).run();
  return { allowed: row !== null, retryAfterSeconds: windowStart + windowSeconds - nowSec };
}

export const countQuotaUsage = (db: D1Like, ownerId: string, dayStartIso: string) =>
  db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotes WHERE owner_id = ?1 AND revoked_at IS NULL) AS active,
            (SELECT COUNT(*) FROM quotes WHERE owner_id = ?1 AND created_at >= ?2) AS today`,
  ).bind(ownerId, dayStartIso).first<{ active: number; today: number }>();

export type QuotaDenied = { ok: false; reason: 'ACTIVE' | 'DAILY'; used: number; limit: number };

/**
 * Cria o orçamento SOMENTE se as duas cotas permitirem, em um único INSERT ... SELECT ... WHERE (atômico):
 * não há "verificar e depois inserir", então criações concorrentes não furam a cota.
 */
export async function insertQuoteWithinQuotas(
  db: D1Like, row: { id: string; payload: string; now: string; ownerId: string; dayStartIso: string; quotaActive: number; quotaDaily: number },
): Promise<{ ok: true } | QuotaDenied> {
  const r = await db.prepare(
    `INSERT INTO quotes (id, payload, created_at, updated_at, owner_id)
     SELECT ?1, ?2, ?3, ?3, ?4
     WHERE (SELECT COUNT(*) FROM quotes WHERE owner_id = ?4 AND revoked_at IS NULL) < ?5
       AND (SELECT COUNT(*) FROM quotes WHERE owner_id = ?4 AND created_at >= ?6) < ?7`,
  ).bind(row.id, row.payload, row.now, row.ownerId, row.quotaActive, row.dayStartIso, row.quotaDaily).run();
  if ((r.meta.changes ?? 0) > 0) return { ok: true };
  // Só para explicar o motivo (a decisão já foi tomada de forma atômica acima).
  const usage = await countQuotaUsage(db, row.ownerId, row.dayStartIso);
  if ((usage?.active ?? 0) >= row.quotaActive) return { ok: false, reason: 'ACTIVE', used: usage?.active ?? 0, limit: row.quotaActive };
  return { ok: false, reason: 'DAILY', used: usage?.today ?? 0, limit: row.quotaDaily };
}
