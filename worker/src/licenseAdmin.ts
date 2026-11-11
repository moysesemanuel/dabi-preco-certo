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

export function issueLicenseSql(o: { id: string; keyHash: string; label?: string; quotaActive: number; quotaDaily: number; now: string }): string {
  must(KEY_HASH_PATTERN.test(o.keyHash), 'Hash da chave inválido.');
  must(o.label === undefined || LABEL_PATTERN.test(o.label), 'Rótulo inválido (use até 60 letras, números e . _ @ # , ( ) - /).');
  return `INSERT INTO licenses (id, key_hash, label, status, quota_active, quota_daily, created_at) VALUES (${text(id(o.id))}, ${text(o.keyHash)}, ${o.label === undefined ? 'NULL' : text(o.label)}, 'active', ${posInt(o.quotaActive, 'Cota de orçamentos ativos')}, ${posInt(o.quotaDaily, 'Cota diária')}, ${text(isoNow(o.now))})`;
}

/** Ativa (reativa) ou revoga uma licença. */
export function setLicenseStatusSql(licenseId: string, status: 'active' | 'revoked', now: string): string {
  return status === 'active'
    ? `UPDATE licenses SET status = 'active', revoked_at = NULL WHERE id = ${text(id(licenseId))}`
    : `UPDATE licenses SET status = 'revoked', revoked_at = ${text(isoNow(now))} WHERE id = ${text(id(licenseId))} AND status = 'active'`;
}

/** Retira do ar todos os orçamentos ainda ativos da licença (opção do comando de revogação). */
export const revokeLicenseQuotesSql = (licenseId: string, now: string) =>
  `UPDATE quotes SET revoked_at = ${text(isoNow(now))}, updated_at = ${text(isoNow(now))} WHERE owner_id = ${text(id(licenseId))} AND revoked_at IS NULL`;

const STATUS_COLUMNS = (dayStartIso: string) => `l.id, l.label, l.status, l.quota_active, l.quota_daily, l.created_at, l.revoked_at,
  (SELECT COUNT(*) FROM quotes q WHERE q.owner_id = l.id AND q.revoked_at IS NULL) AS active_quotes,
  (SELECT COUNT(*) FROM quotes q WHERE q.owner_id = l.id AND q.created_at >= ${text(isoNow(dayStartIso))}) AS created_today`;

/** Nunca seleciona key_hash. */
export const licenseStatusSql = (licenseId: string, dayStartIso: string) => `SELECT ${STATUS_COLUMNS(dayStartIso)} FROM licenses l WHERE l.id = ${text(id(licenseId))}`;
export const listLicensesSql = (dayStartIso: string) => `SELECT ${STATUS_COLUMNS(dayStartIso)} FROM licenses l ORDER BY l.created_at DESC LIMIT 200`;
