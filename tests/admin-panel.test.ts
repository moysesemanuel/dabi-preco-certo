import { beforeEach, describe, expect, it } from 'vitest';
import { runLicensesCli, type CliDeps } from '../worker/scripts/licensesCli';
import { emptyPush } from '../shared/sync';
import { makeServer, type Server, type Session } from './helpers/server';

// Painel administrativo: testes contra o Worker REAL com SQLite e as migrações reais (inclui a 0009). Nada toca a rede.
let srv: Server; let adm: Session; let cli: Session; let adminUserId: string;
const grant = (userId: string) => srv.db.raw.prepare("INSERT INTO admins (user_id, role, granted_at, granted_by) VALUES (?, 'owner', ?, 'cli')").run(userId, srv.state.clock.toISOString());
const userIdOf = (email: string) => (srv.db.raw.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string }).id;
const A = (m: string, p: string, body?: unknown, s: Session = adm) => srv.request(m, `/api/admin${p}`, { session: s, body });
const j = async (r: Response) => (await r.json()) as Record<string, any>;
const licenseOf = (email: string) => (srv.db.raw.prepare('SELECT id FROM licenses WHERE email = ?').get(email) as { id: string }).id;
const raw = (m: string, p: string, o: { s?: Session | null; origin?: string | null; csrf?: string; headers?: Record<string, string>; body?: unknown } = {}) => srv.handle(new Request(`https://api.exemplo.test/api/admin${p}`, { method: m, body: o.body === undefined ? undefined : JSON.stringify(o.body), headers: { 'content-type': 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? 'http://localhost:5174' }), ...(o.s === null ? {} : { cookie: (o.s ?? adm).cookie, 'x-csrf-token': o.csrf ?? (o.s ?? adm).csrf }), ...o.headers } }), srv.env);

beforeEach(async () => {
  srv = makeServer();
  await srv.issueFor('dono@exemplo.com'); await srv.issueFor('ana@exemplo.com'); await srv.issueFor('bruno@exemplo.com');
  adm = await srv.login('dono@exemplo.com', 'Notebook do dono', '10.0.0.1'); cli = await srv.login('ana@exemplo.com', 'Celular da Ana', '10.0.0.2');
  adminUserId = userIdOf('dono@exemplo.com'); grant(adminUserId);
});

describe('Autorização no servidor', () => {
  const ROUTES: [string, string, unknown?][] = [['GET', '/me'], ['GET', '/overview'], ['GET', '/customers'], ['POST', '/customers', { email: 'x@exemplo.com' }], ['GET', '/audit'], ['GET', '/customers/lic_0123456789abcdef'], ['POST', '/customers/lic_0123456789abcdef/suspend', { confirmEmail: 'a@b.co' }], ['POST', '/customers/lic_0123456789abcdef/activate', {}], ['POST', '/customers/lic_0123456789abcdef/sessions/revoke-all', {}], ['DELETE', '/customers/lic_0123456789abcdef/sessions/ses_0123456789abcdef']];
  it('sem sessão: 401 em toda rota administrativa', async () => { for (const [m, p, b] of ROUTES) expect((await raw(m, p, { s: null, body: b })).status, `${m} ${p}`).toBe(401); });
  it('usuário comum (com licença ativa e sessão válida): 403 em TODAS as rotas e nada muda', async () => {
    const before = JSON.stringify([srv.table('licenses'), srv.table('sessions'), srv.table('admins'), srv.table('admin_audit')]);
    for (const [m, p, b] of ROUTES) expect((await raw(m, p, { s: cli, body: b })).status, `${m} ${p}`).toBe(403);
    expect(JSON.stringify([srv.table('licenses'), srv.table('sessions'), srv.table('admins'), srv.table('admin_audit')])).toBe(before);
  });
  it('manipular o cliente não concede nada: role/admin em corpo, cabeçalhos e consulta são ignorados', async () => {
    const res = await raw('POST', '/customers?role=owner&admin=1', { s: cli, headers: { 'x-role': 'owner', 'x-admin': 'true', authorization: 'Bearer admin' }, body: { email: 'novo@exemplo.com', role: 'owner', admin: true, isAdmin: true } });
    expect(res.status).toBe(403); expect(srv.table('admins')).toHaveLength(1);
    expect((await raw('GET', '/me', { s: cli, headers: { 'x-role': 'owner' } })).status).toBe(403);
  });
  it('não existe rota para criar/conceder administradores', async () => {
    for (const p of ['/admins', '/grant', '/customers/' + licenseOf('ana@exemplo.com') + '/admin', '/users/promote']) expect([403, 404, 405]).toContain((await raw('POST', p, { body: { email: 'ana@exemplo.com', role: 'owner' } })).status);
    expect(srv.table('admins')).toHaveLength(1);
  });
  it('o administrador é reconhecido pelo servidor: /me confirma', async () => { const r = await A('GET', '/me'); expect(r.status).toBe(200); expect(await j(r)).toEqual({ admin: true, email: 'dono@exemplo.com' }); });
  it('sessão revogada não acessa a administração (nem a conta, depois de desativada)', async () => {
    const other = await srv.login('dono@exemplo.com', 'Segundo aparelho', '10.0.0.1');
    expect((await srv.request('POST', '/api/auth/logout', { session: other })).status).toBe(200);
    expect((await A('GET', '/overview', undefined, other)).status).toBe(401);
    srv.db.raw.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-11-12T15:00:00.000Z', adminUserId);
    expect((await A('GET', '/overview')).status).toBe(401);
  });
  it('licença suspensa tira as permissões administrativas; reativada, voltam', async () => {
    srv.db.raw.prepare("UPDATE licenses SET status = 'revoked' WHERE email = 'dono@exemplo.com'").run();
    expect((await A('GET', '/overview')).status).toBe(403);
    srv.db.raw.prepare("UPDATE licenses SET status = 'active' WHERE email = 'dono@exemplo.com'").run();
    expect((await A('GET', '/overview')).status).toBe(200);
  });
  it('permissão revogada (admins.revoked_at) vale na PRÓXIMA requisição', async () => {
    expect((await A('GET', '/overview')).status).toBe(200);
    srv.db.raw.prepare('UPDATE admins SET revoked_at = ? WHERE user_id = ?').run('2026-11-12T15:00:00.000Z', adminUserId);
    expect((await A('GET', '/overview')).status).toBe(403);
  });
  it('CSRF: sem token, token de outra sessão ou origem não autorizada recusam as ações que alteram dados', async () => {
    const body = { email: 'x@exemplo.com' };
    expect((await raw('POST', '/customers', { csrf: 'errado', body })).status).toBe(403);
    expect((await raw('POST', '/customers', { csrf: cli.csrf, body })).status).toBe(403);
    expect((await raw('POST', '/customers', { origin: 'https://evil.example', body })).status).toBe(403);
    expect((await raw('POST', '/customers', { origin: null, body })).status).toBe(403);
    expect(srv.table('licenses')).toHaveLength(3);
  });
  it('limite de taxa nas rotas administrativas', async () => {
    let last = 200; for (let i = 0; i < 35 && last !== 429; i++) last = (await A('POST', '/customers', { email: `lote${i}@exemplo.com` })).status;
    expect(last).toBe(429);
  });
});

describe('Painel: visão geral e clientes', () => {
  it('indicadores reais e simples', async () => {
    srv.db.raw.prepare("UPDATE licenses SET status = 'revoked' WHERE email = 'bruno@exemplo.com'").run();
    const o = await j(await A('GET', '/overview'));
    expect(o.customers).toEqual({ total: 3, active: 2, suspended: 1, pendingFirstLogin: 1, new30d: 3 });
    expect(o.activeSessions).toBe(2); expect(o.recentUsers7d).toBe(2);
  });
  it('listagem paginada por cursor: sem repetir nem perder, e com limite máximo', async () => {
    for (let i = 0; i < 57; i++) { srv.state.clock = new Date(Date.parse('2026-11-12T15:00:00Z') + (i % 7) * 1000); await srv.issueFor(`cli${String(i).padStart(2, '0')}@exemplo.com`); }
    srv.state.clock = new Date('2026-11-12T15:00:00Z');
    const seen: string[] = []; let cursor: string | null = null; let pages = 0;
    do { const r = await j(await A('GET', `/customers?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)); expect(r.customers.length).toBeLessThanOrEqual(20); seen.push(...r.customers.map((c: { id: string }) => c.id)); cursor = r.nextCursor; pages++; } while (cursor && pages < 20);
    expect(seen).toHaveLength(60); expect(new Set(seen).size).toBe(60); expect(pages).toBe(3);
    expect((await j(await A('GET', '/customers?limit=9999'))).customers.length).toBe(50);
  });
  it('pesquisa por e-mail ou rótulo, filtro de situação, e curingas LIKE tratados como texto', async () => {
    srv.db.raw.prepare("UPDATE licenses SET label = 'Doces da Bia' WHERE email = 'bruno@exemplo.com'").run();
    expect((await j(await A('GET', '/customers?q=ANA@'))).customers.map((c: { email: string }) => c.email)).toEqual(['ana@exemplo.com']);
    expect((await j(await A('GET', '/customers?q=doces'))).customers.map((c: { email: string }) => c.email)).toEqual(['bruno@exemplo.com']);
    expect((await j(await A('GET', '/customers?q=%25'))).customers).toEqual([]); expect((await j(await A('GET', '/customers?q=_'))).customers).toEqual([]);
    srv.db.raw.prepare("UPDATE licenses SET status = 'revoked' WHERE email = 'ana@exemplo.com'").run();
    expect((await j(await A('GET', '/customers?status=revoked'))).customers.map((c: { email: string }) => c.email)).toEqual(['ana@exemplo.com']);
    expect((await A('GET', '/customers?status=hack')).status).toBe(400); expect((await A('GET', "/customers?cursor=x'--")).status).toBe(400);
  });
  it('a linha traz situação, cadastro, último acesso e sessões ativas', async () => {
    const row = (await j(await A('GET', '/customers?q=ana@'))).customers[0];
    expect(row).toMatchObject({ email: 'ana@exemplo.com', status: 'active', activeSessions: 1, isAdmin: false }); expect(row.createdAt).toBeTruthy(); expect(row.lastAccessAt).toBeTruthy();
    const pending = (await j(await A('GET', '/customers?q=bruno@'))).customers[0]; expect(pending).toMatchObject({ activeSessions: 0, lastAccessAt: null, accountId: null });
  });
});

describe('Cadastro de cliente', () => {
  it('cria a licença sem enviar e-mail; o primeiro login usa o fluxo normal', async () => {
    const mails = srv.mail.outbox.length;
    const r = await A('POST', '/customers', { email: '  Nova@Exemplo.COM ', label: 'Doces da Nova', quotaActive: 50 }); expect(r.status).toBe(201);
    const body = await j(r); expect(body).toMatchObject({ created: true, email: 'nova@exemplo.com' });
    expect(srv.mail.outbox.length).toBe(mails); // nenhum código enviado automaticamente
    expect(srv.table('licenses').find(l => l.email === 'nova@exemplo.com')).toMatchObject({ status: 'active', quota_active: 50, quota_daily: 30, label: 'Doces da Nova', user_id: null });
    const s = await srv.login('nova@exemplo.com', 'Aparelho'); expect((await srv.request('GET', '/api/auth/session', { session: s })).status).toBe(200);
  });
  it('idempotente: repetir (ou variar a caixa do e-mail) não duplica licença, não muda a existente e é auditado como "already-exists"', async () => {
    await A('POST', '/customers', { email: 'nova@exemplo.com', quotaActive: 7 });
    const again = await A('POST', '/customers', { email: 'NOVA@exemplo.com', quotaActive: 999 }); expect(again.status).toBe(200); expect((await j(again)).created).toBe(false);
    const sims = await Promise.all([1, 2, 3].map(() => A('POST', '/customers', { email: 'corrida@exemplo.com' })));
    expect(srv.table('licenses').filter(l => l.email === 'nova@exemplo.com')).toHaveLength(1); expect(srv.table('licenses').filter(l => l.email === 'corrida@exemplo.com')).toHaveLength(1);
    expect(srv.table('licenses').find(l => l.email === 'nova@exemplo.com')!.quota_active).toBe(7);
    expect(sims.filter(r => r.status === 201)).toHaveLength(1);
    expect((await A('POST', '/customers', { email: 'ana@exemplo.com' })).status).toBe(200); // já existente, mesmo ativa e com conta
  });
  it.each([[{ email: 'sem-arroba' }], [{ email: 'a@b.co', label: '<script>' }], [{ email: 'a@b.co', quotaActive: -1 }], [{ email: 'a@b.co', quotaDaily: 1.5 }], [{ email: 'a@b.co', quotaActive: '5' }], [{}], [{ email: ['a@b.co'] }]])('payload inválido %j → 400 sem gravar', async body => {
    expect((await A('POST', '/customers', body)).status).toBe(400); expect(srv.table('licenses')).toHaveLength(3);
  });
  it('corpo inválido ou grande demais', async () => {
    expect((await srv.handle(new Request('https://api.exemplo.test/api/admin/customers', { method: 'POST', body: '{ruim', headers: { cookie: adm.cookie, 'x-csrf-token': adm.csrf, origin: 'http://localhost:5174' } }), srv.env)).status).toBe(400);
    expect((await A('POST', '/customers', { email: 'a@b.co', label: 'x'.repeat(5000) })).status).toBe(413);
  });
});

describe('Suspensão e reativação', () => {
  const sus = (email: string, confirm = email) => A('POST', `/customers/${licenseOf(email)}/suspend`, { confirmEmail: confirm });
  it('exige a confirmação do e-mail no servidor; sem ela nada muda', async () => {
    expect((await sus('ana@exemplo.com', 'outra@exemplo.com')).status).toBe(400);
    expect((await A('POST', `/customers/${licenseOf('ana@exemplo.com')}/suspend`, {})).status).toBe(400);
    expect(srv.table('licenses').find(l => l.email === 'ana@exemplo.com')!.status).toBe('active'); expect(srv.table('admin_audit')).toHaveLength(0);
  });
  it('a conta suspensa não opera (sync, orçamentos), mantém a sessão e o dado financeiro, e os outros clientes seguem isolados', async () => {
    const bruno = await srv.login('bruno@exemplo.com', 'B', '10.0.0.3');
    const p = emptyPush(0); p.upserts.ingredients.push({ id: 'i1', name: 'Segredo da Ana', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 } as never);
    expect((await srv.request('POST', '/api/sync/v2/push', { session: cli, body: p })).status).toBe(200);
    const before = JSON.stringify(srv.table('ingredients'));
    expect((await sus('ana@exemplo.com')).status).toBe(200);
    expect((await srv.request('GET', '/api/sync/v2?since=0', { session: cli })).status).toBe(403); expect((await srv.request('POST', '/api/sync/v2/push', { session: cli, body: emptyPush(0) })).status).toBe(403);
    expect((await srv.request('GET', '/api/quotes', { session: cli })).status).toBe(403);
    const me = await j(await srv.request('GET', '/api/auth/session', { session: cli })); expect(me.license.status).toBe('revoked'); // a UI mostra a mensagem e deixa exportar backup
    expect(JSON.stringify(srv.table('ingredients'))).toBe(before); // nada apagado
    expect((await srv.request('GET', '/api/sync/v2?since=0', { session: bruno })).status).toBe(200);
    await srv.request('POST', '/api/auth/logout', { session: cli }); srv.mail.outbox.splice(0);
    await srv.request('POST', '/api/auth/request-code', { body: { email: 'ana@exemplo.com' } }); expect(srv.mail.outbox.length).toBe(0); // suspensa não recebe código de login
  });
  it('suspender duas vezes é seguro (noop auditado); reativar devolve o acesso', async () => {
    await sus('ana@exemplo.com'); const again = await j(await sus('ana@exemplo.com')); expect(again.changed).toBe(false);
    const act = await A('POST', `/customers/${licenseOf('ana@exemplo.com')}/activate`, {}); expect((await j(act)).changed).toBe(true);
    expect((await srv.request('GET', '/api/sync/v2?since=0', { session: cli })).status).toBe(200);
    expect(srv.table('admin_audit').map(a => `${a.action}:${a.result}`)).toEqual(['customer.suspend:ok', 'customer.suspend:noop', 'customer.activate:ok']);
  });
  it('contas administrativas não são suspensas pelo painel (nem o próprio dono)', async () => { const r = await sus('dono@exemplo.com'); expect(r.status).toBe(409); expect(srv.table('licenses').find(l => l.email === 'dono@exemplo.com')!.status).toBe('active'); });
  it('cliente inexistente ou id malformado: 404', async () => {
    expect((await A('POST', '/customers/lic_ffffffffffffffff/suspend', { confirmEmail: 'a@b.co' })).status).toBe(404); expect((await A('POST', '/customers/lic_ZZ/suspend', {})).status).toBe(404);
  });
});

describe('Detalhes e sessões', () => {
  it('detalhes mostram só dados administrativos e NUNCA tokens, códigos nem conteúdo do cliente', async () => {
    const p = emptyPush(0); p.upserts.ingredients.push({ id: 'i1', name: 'Receita secreta', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 } as never); await srv.request('POST', '/api/sync/v2/push', { session: cli, body: p });
    expect((await srv.request('POST', '/api/quotes', { session: cli, body: { version: 1, quoteNumber: 'Q1', businessName: 'Doces Privados', issuedAt: '2026-11-12', items: [{ description: 'Bolo privado', quantity: 1, unitPriceCents: 5000 }] } })).status).toBe(201); // o orçamento existe de verdade
    const lic = licenseOf('ana@exemplo.com'); const dump = JSON.stringify([await j(await A('GET', `/customers/${lic}`)), await j(await A('GET', '/customers?q=ana')), await j(await A('GET', '/overview')), await j(await A('GET', '/audit'))]);
    expect(dump).toContain('ana@exemplo.com');
    for (const secret of ['Receita secreta', 'Doces Privados', 'Bolo privado', cli.csrf, cli.cookie.split('=')[1], 'token_hash', 'csrf_token', 'code_hash', 'key_hash', 'purchasePrice']) expect(dump, secret).not.toContain(secret);
    const d = await j(await A('GET', `/customers/${lic}`)); expect(d.customer).toMatchObject({ id: lic, email: 'ana@exemplo.com', status: 'active', accountId: userIdOf('ana@exemplo.com'), quotaActive: 100 }); expect(d.sessions).toHaveLength(1); expect(Object.keys(d.sessions[0]).sort()).toEqual(['createdAt', 'deviceLabel', 'expiresAt', 'id', 'lastSeenAt']);
  });
  it('revogar uma sessão: o dispositivo perde o acesso, a outra segue, e a sessão revogada deixa de aparecer como ativa', async () => {
    const second = await srv.login('ana@exemplo.com', 'Notebook', '10.0.0.2'); const lic = licenseOf('ana@exemplo.com');
    expect((await j(await A('GET', `/customers/${lic}`))).sessions).toHaveLength(2);
    expect((await A('DELETE', `/customers/${lic}/sessions/${cli.sessionId}`)).status).toBe(200);
    expect((await srv.request('GET', '/api/auth/session', { session: cli })).status).toBe(401); expect((await srv.request('GET', '/api/auth/session', { session: second })).status).toBe(200);
    const d = await j(await A('GET', `/customers/${lic}`)); expect(d.sessions.map((s: { id: string }) => s.id)).toEqual([second.sessionId]);
    expect((await A('DELETE', `/customers/${lic}/sessions/${cli.sessionId}`)).status).toBe(404); // já encerrada
    expect((await j(await A('GET', '/customers?q=ana'))).customers[0].activeSessions).toBe(1);
  });
  it('sessão de OUTRA conta não pode ser encerrada pelo caminho de um cliente (404) e nada muda', async () => {
    const bruno = await srv.login('bruno@exemplo.com', 'B', '10.0.0.3');
    expect((await A('DELETE', `/customers/${licenseOf('ana@exemplo.com')}/sessions/${bruno.sessionId}`)).status).toBe(404);
    expect((await srv.request('GET', '/api/auth/session', { session: bruno })).status).toBe(200);
  });
  it('revogar todas: exige confirmação, derruba todos os dispositivos e registra a quantidade', async () => {
    const second = await srv.login('ana@exemplo.com', 'Notebook', '10.0.0.2'); const lic = licenseOf('ana@exemplo.com');
    expect((await A('POST', `/customers/${lic}/sessions/revoke-all`, { confirmEmail: 'x@exemplo.com' })).status).toBe(400);
    expect((await srv.request('GET', '/api/auth/session', { session: second })).status).toBe(200);
    expect(await j(await A('POST', `/customers/${lic}/sessions/revoke-all`, { confirmEmail: 'ana@exemplo.com' }))).toMatchObject({ revoked: 2 });
    for (const s of [cli, second]) expect((await srv.request('GET', '/api/auth/session', { session: s })).status).toBe(401);
    expect(srv.table('admin_audit').at(-1)).toMatchObject({ action: 'session.revoke-all', result: 'ok', detail: 'sessions=2' });
    const slot = await srv.login('ana@exemplo.com', 'De novo', '10.0.0.2'); expect(slot.sessionId).toBeTruthy(); // as vagas voltaram
  });
});

describe('Auditoria', () => {
  it('registra quem, o quê, qual conta, quando e o resultado; sem segredos', async () => {
    srv.state.clock = new Date('2026-11-13T09:30:00Z');
    await A('POST', '/customers', { email: 'nova@exemplo.com' }); const lic = licenseOf('nova@exemplo.com');
    await A('POST', `/customers/${lic}/suspend`, { confirmEmail: 'nova@exemplo.com' });
    const ev = (await j(await A('GET', '/audit'))).events;
    expect(ev.map((e: { action: string }) => e.action)).toEqual(['customer.suspend', 'customer.create']); // mais recentes primeiro
    expect(ev[0]).toMatchObject({ admin: 'dono@exemplo.com', licenseId: lic, customerEmail: 'nova@exemplo.com', result: 'ok', at: '2026-11-13T09:30:00.000Z' });
    const raw = JSON.stringify(srv.table('admin_audit')); for (const s of [adm.csrf, adm.cookie.split('=')[1]]) expect(raw).not.toContain(s);
  });
  it('paginada e com limites; por conta', async () => {
    for (let i = 0; i < 12; i++) await A('POST', '/customers', { email: `c${i}@exemplo.com` });
    const p1 = await j(await A('GET', '/audit?limit=5')); expect(p1.events).toHaveLength(5); expect(p1.nextCursor).toBeTruthy();
    const p2 = await j(await A('GET', `/audit?limit=5&cursor=${p1.nextCursor}`)); expect(p2.events[0].id).toBeLessThan(p1.events[4].id);
    expect((await j(await A('GET', '/audit?limit=100000'))).events).toHaveLength(12);
    expect((await j(await A('GET', `/audit?licenseId=${licenseOf('c3@exemplo.com')}`))).events).toHaveLength(1);
    expect((await A('GET', '/audit?cursor=abc')).status).toBe(400); expect((await A('GET', '/audit?licenseId=x')).status).toBe(400);
  });
  it('retenção: eventos com mais de 1 ano são apagados na próxima ação administrativa', async () => {
    srv.db.raw.prepare("INSERT INTO admin_audit (at, admin_user_id, action, result) VALUES ('2025-01-01T00:00:00.000Z', 'x', 'customer.create', 'ok')").run();
    await A('POST', '/customers', { email: 'nova@exemplo.com' });
    expect(srv.table('admin_audit').map(a => a.at as string).every(at => at > '2026')).toBe(true);
  });
  it('ações negadas (não administrador) não gravam nada: um cliente não consegue encher a tabela', async () => { for (let i = 0; i < 5; i++) await raw('POST', '/customers', { s: cli, body: { email: `x${i}@exemplo.com` } }); expect(srv.table('admin_audit')).toHaveLength(0); });
});

describe('CLI de bootstrap do administrador (simulado sobre SQLite local; nenhum banco remoto)', () => {
  const out: string[] = []; const err: string[] = [];
  const deps = (): CliDeps => ({
    exec: (args: string[]) => { const sql = args[args.indexOf('--command') + 1]; const stmt = srv.db.raw.prepare(sql); const rows = /^\s*(SELECT|WITH)/i.test(sql) ? stmt.all() : (stmt.run(), []); return JSON.stringify([{ results: rows }]); },
    out: l => { out.push(l); }, err: l => { err.push(l); }, now: () => new Date('2026-11-12T15:00:00Z'), isTTY: false, prompt: async () => '',
  });
  beforeEach(() => { out.length = 0; err.length = 0; srv.db.raw.exec('DELETE FROM admins; DELETE FROM admin_audit'); });
  it('concede a um usuário que já fez login; registra auditoria; só uma vez sem --additional', async () => {
    expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'dono@exemplo.com'], deps())).toBe(0);
    expect(srv.table('admins')).toHaveLength(1); expect(srv.table('admin_audit')[0]).toMatchObject({ action: 'admin.grant', admin_user_id: 'cli' });
    expect((await A('GET', '/me')).status).toBe(200);
    expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'ana@exemplo.com'], deps())).toBe(1); expect(err.join('\n')).toContain('--additional'); expect(srv.table('admins')).toHaveLength(1);
    expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'ana@exemplo.com', '--additional'], deps())).toBe(0); expect(srv.table('admins')).toHaveLength(2);
  });
  it('não concede a quem nunca entrou (sem usuário) nem a desativados; ninguém é promovido automaticamente', async () => {
    expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'bruno@exemplo.com'], deps())).toBe(1); expect(srv.table('admins')).toHaveLength(0);
    srv.db.raw.prepare("UPDATE users SET disabled_at = 'x' WHERE email = 'ana@exemplo.com'").run();
    expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'ana@exemplo.com'], deps())).toBe(1); expect(srv.table('admins')).toHaveLength(0);
    expect(srv.table('users').length).toBeGreaterThan(0); // preexistentes seguem sem permissão
  });
  it('revoga e lista; em produção exige confirmação digitada (e-mail)', async () => {
    await runLicensesCli(['grant-admin', '--env', 'local', '--email', 'dono@exemplo.com'], deps());
    expect(await runLicensesCli(['revoke-admin', '--env', 'local', '--email', 'dono@exemplo.com'], deps())).toBe(0); expect((await A('GET', '/me')).status).toBe(403);
    expect(await runLicensesCli(['list-admins', '--env', 'local'], deps())).toBe(0); expect(out.join('\n')).toContain('REVOGADO');
    expect(await runLicensesCli(['grant-admin', '--env', 'production', '--email', 'dono@exemplo.com'], deps())).toBe(1); expect(err.join('\n')).toContain('--confirm-production dono@exemplo.com');
    expect(await runLicensesCli(['grant-admin', '--email', 'dono@exemplo.com'], deps())).toBe(1); // ambiente sempre explícito
  });
  it('e-mail com aspas é tratado como texto (sem injeção)', async () => { expect(await runLicensesCli(['grant-admin', '--env', 'local', '--email', "x'); DROP TABLE users;--@a.co"], deps())).toBe(1); expect(srv.table('users').length).toBeGreaterThan(0); });
});
