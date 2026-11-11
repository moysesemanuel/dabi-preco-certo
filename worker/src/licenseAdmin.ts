import { normalizeEmail } from './accounts.ts';
import { KEY_HASH_PATTERN, LICENSE_ID_PATTERN } from './licenses.ts';

/**
 * Montagem das instruções SQL de administração de licenças (usadas pelo CLI e testadas contra SQLite).
 * Todos os valores são validados por padrão estrito antes de entrar no texto SQL; nunca se concatena texto livre.
 * Estas funções jamais recebem a chave de licença: só o hash dela.
 */
export const LABEL_PATTERN = /^[\p{L}\p{N} ._@#,()\-/]{1,60}$/u;

const text = (v: string) => `'${v.replace(/'/g, "''")}'`;
const must = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const isoNow = (v: string) => { must(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v), 'Data/hora inválida.'); return v; };
const posInt = (v: number, name: string) => { must(Number.isInteger(v) && v >= 0 && v <= 1_000_000, `${name} deve ser um inteiro entre 0 e 1.000.000.`); return v; };
const id = (v: string) => { must(LICENSE_ID_PATTERN.test(v), 'Identificador de licença inválido.'); return v; };

const emailSql = (raw: string) => { const e = normalizeEmail(raw); must(e !== undefined, 'E-mail inválido.'); return text(e as string); };

export function issueLicenseSql(o: { id: string; keyHash: string; label?: string; email?: string; quotaActive: number; quotaDaily: number; now: string }): string {
  must(KEY_HASH_PATTERN.test(o.keyHash), 'Hash da chave inválido.');
  must(o.label === undefined || LABEL_PATTERN.test(o.label), 'Rótulo inválido (use até 60 letras, números e . _ @ # , ( ) - /).');
  return `INSERT INTO licenses (id, key_hash, label, email, status, quota_active, quota_daily, created_at) VALUES (${text(id(o.id))}, ${text(o.keyHash)}, ${o.label === undefined ? 'NULL' : text(o.label)}, ${o.email === undefined ? 'NULL' : emailSql(o.email)}, 'active', ${posInt(o.quotaActive, 'Cota de orçamentos ativos')}, ${posInt(o.quotaDaily, 'Cota diária')}, ${text(isoNow(o.now))})`;
}

/** Ativa (reativa) ou revoga uma licença. */
export function setLicenseStatusSql(licenseId: string, status: 'active' | 'revoked', now: string): string {
  return status === 'active'
    ? `UPDATE licenses SET status = 'active', revoked_at = NULL WHERE id = ${text(id(licenseId))}`
    : `UPDATE licenses SET status = 'revoked', revoked_at = ${text(isoNow(now))} WHERE id = ${text(id(licenseId))} AND status = 'active'`;
}

/** Vincula uma licença existente (ainda sem e-mail) à conta de um comprador. */
export const bindLicenseEmailSql = (licenseId: string, email: string) => `UPDATE licenses SET email = ${emailSql(email)} WHERE id = ${text(id(licenseId))} AND email IS NULL`;

/** Encerra todas as sessões (dispositivos) da conta ligada à licença. */
export const revokeLicenseSessionsSql = (licenseId: string, now: string) =>
  `UPDATE sessions SET revoked_at = ${text(isoNow(now))} WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM licenses WHERE id = ${text(id(licenseId))} AND user_id IS NOT NULL)`;

/** Retira do ar todos os orçamentos ainda ativos da licença (opção do comando de revogação). */
export const revokeLicenseQuotesSql = (licenseId: string, now: string) =>
  `UPDATE quotes SET revoked_at = ${text(isoNow(now))}, updated_at = ${text(isoNow(now))} WHERE owner_id = ${text(id(licenseId))} AND revoked_at IS NULL`;

const STATUS_COLUMNS = (dayStartIso: string) => `l.id, l.label, l.email, l.status, l.quota_active, l.quota_daily, l.created_at, l.revoked_at,
  (SELECT COUNT(*) FROM quotes q WHERE q.owner_id = l.id AND q.revoked_at IS NULL) AS active_quotes,
  (SELECT COUNT(*) FROM quotes q WHERE q.owner_id = l.id AND q.created_at >= ${text(isoNow(dayStartIso))}) AS created_today,
  (SELECT COUNT(*) FROM sessions s WHERE s.user_id = l.user_id AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_sessions`;

/** Nunca seleciona key_hash. */
export const licenseStatusSql = (licenseId: string, dayStartIso: string) => `SELECT ${STATUS_COLUMNS(dayStartIso)} FROM licenses l WHERE l.id = ${text(id(licenseId))}`;
export const listLicensesSql = (dayStartIso: string) => `SELECT ${STATUS_COLUMNS(dayStartIso)} FROM licenses l ORDER BY l.created_at DESC LIMIT 200`;
