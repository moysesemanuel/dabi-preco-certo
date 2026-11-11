import { CODE_MAX_ATTEMPTS } from './accounts';
import type { D1Like, LicenseRow } from './store';

export type UserRow = { id: string; email: string; email_verified_at: string | null; created_at: string; disabled_at: string | null };
export type SessionRow = { id: string; user_id: string; token_hash: string; csrf_token: string; device_label: string | null; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null };
export type CodeRow = { id: string; email: string; code_hash: string; created_at: string; expires_at: string; attempts: number; used_at: string | null };
export type AccountLicense = LicenseRow & { email: string | null; user_id: string | null };

const LICENSE_COLUMNS = 'id, key_hash, label, status, quota_active, quota_daily, created_at, revoked_at, email, user_id';

// ---- usuários e licenças da conta ----
export const findUserByEmail = (db: D1Like, email: string) => db.prepare('SELECT id, email, email_verified_at, created_at, disabled_at FROM users WHERE email = ?').bind(email).first<UserRow>();
export const findUserById = (db: D1Like, id: string) => db.prepare('SELECT id, email, email_verified_at, created_at, disabled_at FROM users WHERE id = ?').bind(id).first<UserRow>();
export async function createVerifiedUser(db: D1Like, id: string, email: string, now: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO users (id, email, email_verified_at, created_at) VALUES (?, ?, ?, ?)').bind(id, email, now, now).run();
}
export const licenseForEmail = (db: D1Like, email: string) => db.prepare(`SELECT ${LICENSE_COLUMNS} FROM licenses WHERE email = ?`).bind(email).first<AccountLicense>();
export const licenseForUser = (db: D1Like, userId: string) => db.prepare(`SELECT ${LICENSE_COLUMNS} FROM licenses WHERE user_id = ?`).bind(userId).first<AccountLicense>();
export async function bindLicenseToUser(db: D1Like, licenseId: string, userId: string): Promise<void> {
  await db.prepare('UPDATE licenses SET user_id = ? WHERE id = ? AND user_id IS NULL').bind(userId, licenseId).run();
}

// ---- códigos de acesso ----
export async function replaceCode(db: D1Like, code: CodeRow, now: string): Promise<void> {
  // Só um código ativo por e-mail: os anteriores deixam de valer.
  await db.prepare('UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL').bind(now, code.email).run();
  await db.prepare('INSERT INTO auth_codes (id, email, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)').bind(code.id, code.email, code.code_hash, code.created_at, code.expires_at).run();
}
export const latestOpenCode = (db: D1Like, email: string, now: string) =>
  db.prepare('SELECT id, email, code_hash, created_at, expires_at, attempts, used_at FROM auth_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(email, now).first<CodeRow>();
/** Consome UMA tentativa de forma atômica; tentativas simultâneas não passam do limite. */
export async function claimAttempt(db: D1Like, codeId: string, now: string): Promise<boolean> {
  const row = await db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING attempts').bind(codeId, now, CODE_MAX_ATTEMPTS).first<{ attempts: number }>();
  return row !== null;
}
export async function markCodeUsed(db: D1Like, codeId: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, codeId).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function discardCode(db: D1Like, codeId: string, now: string): Promise<void> { await markCodeUsed(db, codeId, now); }

// ---- sessões ----
export const ACTIVE = 'revoked_at IS NULL AND expires_at > ?';
export const getSessionByTokenHash = (db: D1Like, tokenHash: string) =>
  db.prepare('SELECT id, user_id, token_hash, csrf_token, device_label, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first<SessionRow>();
export async function listActiveSessions(db: D1Like, userId: string, now: string): Promise<SessionRow[]> {
  const r = await db.prepare(`SELECT id, user_id, token_hash, csrf_token, device_label, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE user_id = ? AND ${ACTIVE} ORDER BY created_at`).bind(userId, now).all<SessionRow>();
  return r.results;
}
/** Cria a sessão SOMENTE se o usuário ainda tiver vaga (um único INSERT ... SELECT ... WHERE: sem corrida entre logins simultâneos). */
export async function insertSessionWithinLimit(db: D1Like, s: Omit<SessionRow, 'revoked_at'>, now: string, max: number): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, device_label, created_at, last_seen_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7
     WHERE (SELECT COUNT(*) FROM sessions WHERE user_id = ?2 AND revoked_at IS NULL AND expires_at > ?8) < ?9`,
  ).bind(s.id, s.user_id, s.token_hash, s.csrf_token, s.device_label, s.created_at, s.expires_at, now, max).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function revokeSession(db: D1Like, userId: string, sessionId: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(now, sessionId, userId).run();
  return (r.meta.changes ?? 0) > 0;
}
export async function touchSession(db: D1Like, sessionId: string, now: string): Promise<void> {
  await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, sessionId).run();
}
