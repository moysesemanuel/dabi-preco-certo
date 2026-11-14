import { addMs, normalizeEmail } from './accounts';
import { activeSessionsOf, auditStatement, AUDIT_PAGE_MAX, AUDIT_RETENTION_DAYS, CUSTOMERS_PAGE_MAX, getActiveAdmin, getCustomer, listAudit, listCustomers, overview, PAGE_DEFAULT, pruneAudit } from './adminStore';
import { apiError, json, readJsonBody } from './http';
import { generateLicenseId, generateLicenseKey, hashLicenseKey, LICENSE_ID_PATTERN } from './licenses';
import { LABEL_PATTERN } from './licenseAdmin';
import { checkCsrf, resolveSession, type SessionEnv } from './session';
import { consumeRateLimit } from './store';

export type AdminDeps = { now: () => Date };
export const ADMIN_RATE = { readPerMinute: 120, writePerMinute: 30 } as const;
const SESSION_ID = /^ses_[0-9a-f]{16}$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|(lic_[0-9a-f]{16})$/;
const DAY = 86_400_000;

type Admin = { userId: string; email: string };
type Gate = { ok: true; admin: Admin } | { ok: false; response: Response };

/**
 * Autorização de TODA rota administrativa, feita no servidor e só com o que o servidor sabe:
 * sessão (cookie HttpOnly) → conta não desativada → licença ativa → linha ativa em `admins` → CSRF (se altera dados) → limite de taxa.
 * Nada vindo do corpo, de cabeçalhos personalizados ou do frontend (role, e-mail, flags) conta como prova de permissão.
 * Quem não é administrador recebe sempre o mesmo 403, sem pistas.
 */
async function authorizeAdmin(request: Request, env: SessionEnv, deps: AdminDeps, write: boolean): Promise<Gate> {
  const r = await resolveSession(request, env, deps.now());
  if (!r.ok) return { ok: false, response: apiError(r.status, r.error, r.message) };
  const forbidden = () => ({ ok: false as const, response: apiError(403, 'FORBIDDEN', 'Acesso negado.') });
  if (!r.ctx.license || r.ctx.license.status !== 'active') return forbidden(); // conta suspensa perde as permissões administrativas
  if (!(await getActiveAdmin(env.DB, r.ctx.user.id))) return forbidden();
  if (write) { const c = checkCsrf(request, env, r.ctx.session); if (c) return { ok: false, response: apiError(c.status, c.error, c.message) }; }
  const rate = await consumeRateLimit(env.DB, `adm_${r.ctx.user.id}`, write ? 'admin-write' : 'admin-read', write ? ADMIN_RATE.writePerMinute : ADMIN_RATE.readPerMinute, 60, deps.now().getTime());
  if (!rate.allowed) return { ok: false, response: apiError(429, 'RATE_LIMITED', 'Muitas requisições. Aguarde um instante.', { 'Retry-After': String(rate.retryAfterSeconds) }) };
  return { ok: true, admin: { userId: r.ctx.user.id, email: r.ctx.user.email } };
}

const pageSize = (raw: string | null, max: number) => { const n = Number(raw); return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : PAGE_DEFAULT; };
const publicCustomer = (c: { id: string; email: string; label: string | null; status: string; created_at: string; revoked_at: string | null; user_id: string | null; last_seen_at: string | null; is_admin: number }) =>
  ({ id: c.id, email: c.email, label: c.label, status: c.status, createdAt: c.created_at, suspendedAt: c.revoked_at, accountId: c.user_id, lastAccessAt: c.last_seen_at, isAdmin: c.is_admin > 0 });
const publicAudit = (a: Awaited<ReturnType<typeof listAudit>>[number]) => ({ id: a.id, at: a.at, action: a.action, result: a.result, detail: a.detail, admin: a.admin_email ?? (a.admin_user_id === 'cli' ? 'terminal (bootstrap)' : null), licenseId: a.license_id, customerEmail: a.license_email });

/** Roteador /api/admin/*. Devolve undefined se a rota não for administrativa. */
export async function adminRoute(request: Request, env: SessionEnv, deps: AdminDeps, pathname: string): Promise<Response | undefined> {
  if (!pathname.startsWith('/api/admin/') && pathname !== '/api/admin') return undefined;
  const path = pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const iso = deps.now().toISOString();
  const write = method !== 'GET' && method !== 'HEAD';
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');

  const m = path.match(/^\/api\/admin\/customers\/(lic_[0-9a-f]{16})(?:\/(suspend|activate|sessions)(?:\/(revoke-all|ses_[0-9a-f]{16}))?)?$/);
  const known = path === '/api/admin/me' || path === '/api/admin/overview' || path === '/api/admin/customers' || path === '/api/admin/audit' || m;
  if (!known) return apiError(404, 'NOT_FOUND', 'Rota não encontrada.');
  const gate = await authorizeAdmin(request, env, deps, write);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

  if (path === '/api/admin/me' && method === 'GET') return json({ admin: true, email: admin.email });

  if (path === '/api/admin/overview' && method === 'GET') {
    const o = await overview(env.DB, iso, addMs(iso, -30 * DAY), addMs(iso, -7 * DAY));
    return json({ generatedAt: iso, customers: { total: o?.total ?? 0, active: o?.active ?? 0, suspended: o?.suspended ?? 0, pendingFirstLogin: o?.pending_first_login ?? 0, new30d: o?.new_30d ?? 0 }, activeSessions: o?.active_sessions ?? 0, recentUsers7d: o?.recent_users_7d ?? 0 });
  }

  if (path === '/api/admin/customers' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 60);
    const status = url.searchParams.get('status');
    if (status !== null && status !== 'active' && status !== 'revoked') return apiError(400, 'INVALID_REQUEST', 'Filtro de situação inválido.');
    const cur = url.searchParams.get('cursor'); const cm = cur ? CURSOR.exec(cur) : null;
    if (cur && !cm) return apiError(400, 'INVALID_REQUEST', 'Cursor inválido.');
    const limit = pageSize(url.searchParams.get('limit'), CUSTOMERS_PAGE_MAX);
    const rows = await listCustomers(env.DB, { q: q || undefined, status: status ?? undefined, cursor: cm ? { createdAt: cm[1], id: cm[2] } : undefined, limit, nowIso: iso });
    const page = rows.slice(0, limit); const last = page[page.length - 1];
    return json({ customers: page.map(c => ({ ...publicCustomer(c), activeSessions: c.active_sessions })), nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null });
  }

  if (path === '/api/admin/customers' && method === 'POST') {
    const body = await readJsonBody(request, 2048);
    if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
    const b = (body.data ?? {}) as { email?: unknown; label?: unknown; quotaActive?: unknown; quotaDaily?: unknown };
    const email = normalizeEmail(b.email);
    if (!email) return apiError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : null;
    if (b.label !== undefined && b.label !== null && (typeof b.label !== 'string' || (label !== null && !LABEL_PATTERN.test(label)))) return apiError(400, 'INVALID_REQUEST', 'Rótulo inválido (até 60 letras, números e . _ @ # , ( ) - /).');
    const quota = (v: unknown, d: number) => (v === undefined ? d : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000 ? (v as number) : NaN);
    const quotaActive = quota(b.quotaActive, 100), quotaDaily = quota(b.quotaDaily, 30);
    if (Number.isNaN(quotaActive) || Number.isNaN(quotaDaily)) return apiError(400, 'INVALID_REQUEST', 'Cotas devem ser inteiros entre 0 e 10.000.');
    // Idempotente: já existe licença para o e-mail → nada é criado (sem duplicidade, sem sobrescrever) e a resposta aponta a existente.
    const id = generateLicenseId();
    const results = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO licenses (id, key_hash, label, email, status, quota_active, quota_daily, created_at) VALUES (?, ?, ?, ?, \'active\', ?, ?, ?)').bind(id, await hashLicenseKey(generateLicenseKey()), label, email, quotaActive, quotaDaily, iso),
      auditStatement(env.DB, { at: iso, adminUserId: admin.userId, action: 'customer.create', licenseId: id, detailSql: "CASE WHEN changes() > 0 THEN 'created' ELSE 'already-exists' END" }),
    ]);
    await pruneAudit(env.DB, addMs(iso, -AUDIT_RETENTION_DAYS * DAY));
    const created = (results[0].meta.changes ?? 0) > 0;
    if (created) return json({ created: true, id, email }, 201);
    const existing = await env.DB.prepare('SELECT id, status FROM licenses WHERE email = ?').bind(email).first<{ id: string; status: string }>();
    return json({ created: false, id: existing?.id ?? null, status: existing?.status ?? null, email }, 200);
  }

  if (path === '/api/admin/audit' && method === 'GET') {
    const licenseId = url.searchParams.get('licenseId');
    if (licenseId !== null && !LICENSE_ID_PATTERN.test(licenseId)) return apiError(400, 'INVALID_REQUEST', 'Identificador inválido.');
    const cur = url.searchParams.get('cursor');
    if (cur !== null && !/^\d{1,12}$/.test(cur)) return apiError(400, 'INVALID_REQUEST', 'Cursor inválido.');
    const limit = pageSize(url.searchParams.get('limit'), AUDIT_PAGE_MAX);
    const rows = await listAudit(env.DB, { licenseId: licenseId ?? undefined, beforeId: cur !== null ? Number(cur) : undefined, limit });
    const page = rows.slice(0, limit);
    return json({ events: page.map(publicAudit), nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null });
  }

  if (m) {
    const licenseId = m[1]; const sub = m[2]; const arg = m[3];
    const c = await getCustomer(env.DB, licenseId);
    if (!c) return apiError(404, 'NOT_FOUND', 'Cliente não encontrado.');

    if (!sub && method === 'GET') {
      const sessions = c.user_id ? await activeSessionsOf(env.DB, c.user_id, iso) : [];
      const history = await listAudit(env.DB, { licenseId, limit: 20 });
      return json({
        customer: { ...publicCustomer(c), quotaActive: c.quota_active, quotaDaily: c.quota_daily, emailVerifiedAt: c.email_verified_at, accountCreatedAt: c.user_created_at, accountDisabledAt: c.disabled_at },
        sessions: sessions.map(s => ({ id: s.id, deviceLabel: s.device_label, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at })),
        history: history.slice(0, 20).map(publicAudit), historyHasMore: history.length > 20,
      });
    }

    // Ações que alteram dados: o e-mail do cliente precisa ser digitado de novo (confirmação checada NO SERVIDOR, além da tela).
    const needsConfirm = (sub === 'suspend') || (sub === 'sessions' && arg === 'revoke-all');
    if (write && needsConfirm) {
      const body = await readJsonBody(request, 2048);
      if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
      if (normalizeEmail((body.data as { confirmEmail?: unknown } | null)?.confirmEmail) !== c.email) return apiError(400, 'CONFIRMATION_MISMATCH', 'A confirmação não confere com o e-mail do cliente.');
    }
    // Contas administrativas não são suspensas nem desconectadas pelo painel (evita travar o próprio proprietário).
    if (c.is_admin > 0 && (sub === 'suspend' || sub === 'sessions')) return apiError(409, 'ADMIN_ACCOUNT', 'Contas administrativas não são gerenciadas por este painel.');

    const prune = () => pruneAudit(env.DB, addMs(iso, -AUDIT_RETENTION_DAYS * DAY));
    if (sub === 'suspend' && method === 'POST') {
      const r = await env.DB.batch([
        env.DB.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").bind(iso, licenseId),
        auditStatement(env.DB, { at: iso, adminUserId: admin.userId, action: 'customer.suspend', licenseId, targetUserId: c.user_id }),
      ]); await prune();
      return json({ id: licenseId, status: 'revoked', changed: (r[0].meta.changes ?? 0) > 0 });
    }
    if (sub === 'activate' && method === 'POST') {
      const r = await env.DB.batch([
        env.DB.prepare("UPDATE licenses SET status = 'active', revoked_at = NULL WHERE id = ? AND status = 'revoked'").bind(licenseId),
        auditStatement(env.DB, { at: iso, adminUserId: admin.userId, action: 'customer.activate', licenseId, targetUserId: c.user_id }),
      ]); await prune();
      return json({ id: licenseId, status: 'active', changed: (r[0].meta.changes ?? 0) > 0 });
    }
    if (sub === 'sessions' && arg === 'revoke-all' && method === 'POST') {
      if (!c.user_id) return json({ id: licenseId, revoked: 0 });
      const r = await env.DB.batch([
        env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(iso, c.user_id),
        auditStatement(env.DB, { at: iso, adminUserId: admin.userId, action: 'session.revoke-all', licenseId, targetUserId: c.user_id, detailSql: "'sessions=' || changes()" }),
      ]); await prune();
      return json({ id: licenseId, revoked: r[0].meta.changes ?? 0 });
    }
    if (sub === 'sessions' && arg && SESSION_ID.test(arg) && method === 'DELETE') {
      if (!c.user_id) return apiError(404, 'NOT_FOUND', 'Sessão não encontrada.');
      // A sessão precisa pertencer à conta DESTE cliente (id de sessão de outra conta = 404, igual a inexistente).
      const r = await env.DB.batch([
        env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(iso, arg, c.user_id),
        auditStatement(env.DB, { at: iso, adminUserId: admin.userId, action: 'session.revoke', licenseId, targetUserId: c.user_id }),
      ]); await prune();
      if ((r[0].meta.changes ?? 0) === 0) return apiError(404, 'NOT_FOUND', 'Sessão não encontrada ou já encerrada.');
      return json({ id: licenseId, revoked: arg });
    }
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  }
  return apiError(404, 'NOT_FOUND', 'Rota não encontrada.');
}
