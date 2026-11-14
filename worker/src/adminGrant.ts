import { normalizeEmail } from './accounts.ts';

/**
 * SQL do bootstrap/gestão de administradores (usado só pelo CLI, no terminal do operador; NÃO existe rota pública para isto).
 * O administrador precisa ser um usuário que já fez o primeiro login verificado: ninguém ganha acesso administrativo por existir, nem por e-mail
 * informado numa tela. Valores são validados antes de entrar no SQL.
 */
const text = (v: string) => `'${v.replace(/'/g, "''")}'`;
const must = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const email = (raw: string) => { const e = normalizeEmail(raw); must(e !== undefined, 'E-mail inválido.'); return text(e as string); };
const isoNow = (v: string) => { must(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v), 'Data/hora inválida.'); return text(v); };

export const activeAdminCountSql = () => 'SELECT COUNT(*) AS n FROM admins WHERE revoked_at IS NULL';
export const grantAdminSql = (e: string, now: string) =>
  `INSERT INTO admins (user_id, role, granted_at, granted_by) SELECT id, 'owner', ${isoNow(now)}, 'cli' FROM users WHERE email = ${email(e)} AND disabled_at IS NULL ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL, granted_at = excluded.granted_at, granted_by = 'cli'`;
export const revokeAdminSql = (e: string, now: string) =>
  `UPDATE admins SET revoked_at = ${isoNow(now)} WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE email = ${email(e)})`;
export const adminAuditSql = (action: 'admin.grant' | 'admin.revoke', e: string, now: string) =>
  `INSERT INTO admin_audit (at, admin_user_id, action, license_id, target_user_id, result, detail) SELECT ${isoNow(now)}, 'cli', ${text(action)}, NULL, id, 'ok', NULL FROM users WHERE email = ${email(e)}`;
export const listAdminsSql = () => 'SELECT u.email AS email, a.role AS role, a.granted_at AS granted_at, a.granted_by AS granted_by, a.revoked_at AS revoked_at FROM admins a JOIN users u ON u.id = a.user_id ORDER BY a.granted_at';
export const adminByEmailSql = (e: string) => `SELECT u.email AS email FROM admins a JOIN users u ON u.id = a.user_id WHERE u.email = ${email(e)} AND a.revoked_at IS NULL`;
