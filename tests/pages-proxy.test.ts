import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPush } from '../shared/sync';
import { proxy, type ProxyEnv } from '../functions/_shared/proxy';
import { makeServer, type Server } from './helpers/server';
import { ENVIRONMENTS, parseArgs, validateDist } from '../scripts/pages.mjs';

const HOST = 'https://precocerto.dabitech.com.br';
const req = (path: string, init: RequestInit & { host?: string } = {}) => new Request(`${init.host ?? HOST}${path}`, init);
const upstreamOk = (over: { status?: number; headers?: Record<string, string> } = {}) => vi.fn(async (r: Request) => new Response(JSON.stringify({ method: r.method, path: new URL(r.url).pathname, body: r.method === 'GET' ? null : await r.text() }), { status: over.status ?? 200, headers: over.headers ?? {} }));
const envWith = (fetch: (r: Request) => Promise<Response>, appEnv = 'staging'): ProxyEnv => ({ API: { fetch }, APP_ENV: appEnv });

describe('Proxy do Pages: não é um proxy aberto', () => {
  it.each(['/', '/admin', '/api', '/api/', '/apix/y', '/o', '/o/', '/outro/api/x', '//evil.example/api/x', '/healthz', '/api/../admin', '/api/%2e%2e/x', '/api/a%2fb', '/api/a%5cb', '/api/a%00b'])('recusa o caminho %s sem chamar o Worker', async path => {
    const up = upstreamOk(); const res = await proxy(req(path), envWith(up));
    expect([400, 404]).toContain(res.status); expect(up).not.toHaveBeenCalled();
  });
  it('encaminha somente /api/* e /o/*', async () => {
    const up = upstreamOk(); for (const p of ['/api/auth/session', '/api/sync?since=0', '/o/abc']) expect((await proxy(req(p), envWith(up))).status).toBe(200);
    expect(up).toHaveBeenCalledTimes(3);
  });
  it('métodos fora da lista (PATCH, PROPFIND, LOCK) são recusados com 405', async () => {
    const up = upstreamOk(); for (const m of ['PATCH', 'PROPFIND', 'LOCK']) { const r = await proxy(req('/api/x', { method: m }), envWith(up)); expect(r.status, m).toBe(405); }
    expect(up).not.toHaveBeenCalled();
  });
  it('o destino é só o binding: o host e cabeçalhos do cliente não escolhem nada', async () => {
    const up = upstreamOk(); await proxy(req('/api/auth/session', { host: 'https://qualquer.outro.host', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-original-url': 'https://evil.example/' } }), envWith(up));
    expect(up).toHaveBeenCalledTimes(1); // só o binding é chamado; não existe fetch() para URL arbitrária no código
  });
  it('sem o Service Binding ou com APP_ENV inválido: 503 e nada é encaminhado', async () => {
    expect((await proxy(req('/api/x'), { APP_ENV: 'staging' })).status).toBe(503);
    for (const e of [undefined, '', 'prod', 'STAGING', 'development']) expect((await proxy(req('/api/x'), { API: { fetch: upstreamOk() }, APP_ENV: e })).status, String(e)).toBe(503);
  });
  it('/api/_edge/health responde sem tocar no Worker e só revela ambiente e presença do binding', async () => {
    const up = upstreamOk(); const res = await proxy(req('/api/_edge/health'), envWith(up, 'staging'));
    expect(await res.json()).toEqual({ ok: true, env: 'staging', binding: true }); expect(up).not.toHaveBeenCalled(); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await (await proxy(req('/api/_edge/health'), {})).json()).toEqual({ ok: false, env: null, binding: false });
    await proxy(req('/api/_edge/health', { method: 'POST', body: '{}' }), envWith(up)); expect(up).toHaveBeenCalledTimes(1); // só GET/HEAD é o diagnóstico; POST segue para o Worker
  });
  it('corpo gigante é recusado antes de encaminhar', async () => {
    const up = upstreamOk(); const r = await proxy(req('/api/sync/push', { method: 'POST', headers: { 'content-length': String(3 * 1024 * 1024) }, body: 'x' }), envWith(up)); expect(r.status).toBe(413); expect(up).not.toHaveBeenCalled();
  });
});

describe('Proxy do Pages: fidelidade (método, corpo, cookies, cabeçalhos, status)', () => {
  it('preserva método, corpo, cookie, CSRF, origem e IP; só acrescenta X-Dabi-Expect-Env (sobrescrevendo o do cliente)', async () => {
    let seen: Request | undefined; const up = vi.fn(async (r: Request) => { seen = r; return new Response('{}'); });
    await proxy(req('/api/sync/push?x=1', { method: 'POST', body: '{"a":1}', headers: { cookie: '__Host-dabi_session=abc', 'x-csrf-token': 't0k', origin: HOST, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'x-dabi-expect-env': 'production' } }), envWith(up, 'staging'));
    expect(seen!.method).toBe('POST'); expect(await seen!.text()).toBe('{"a":1}'); expect(new URL(seen!.url).pathname + new URL(seen!.url).search).toBe('/api/sync/push?x=1');
    for (const [k, v] of Object.entries({ cookie: '__Host-dabi_session=abc', 'x-csrf-token': 't0k', origin: HOST, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' })) expect(seen!.headers.get(k), k).toBe(v);
    expect(seen!.headers.get('x-dabi-expect-env')).toBe('staging'); expect(seen!.redirect).toBe('manual');
  });
  it.each([[200], [201], [204], [400], [401], [403], [404], [410], [413], [429], [500], [503]])('status %i passa sem alteração (Retry-After inclusive)', async status => {
    const res = await proxy(req('/api/x'), envWith(vi.fn(async () => new Response(status === 204 ? null : '{"e":1}', { status, headers: { 'retry-after': '7', 'content-type': 'application/json' } }))));
    expect(res.status).toBe(status); expect(res.headers.get('retry-after')).toBe('7');
  });
  it('vários Set-Cookie e o corpo voltam intactos; cache-control do Worker é respeitado e o ausente vira no-store', async () => {
    const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' }); h.append('set-cookie', 'a=1; Path=/; HttpOnly'); h.append('set-cookie', 'b=2; Path=/; HttpOnly');
    const res = await proxy(req('/api/x'), envWith(vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: h }))));
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/; HttpOnly']); expect(await res.text()).toBe('{"ok":true}'); expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await proxy(req('/api/x'), envWith(vi.fn(async () => new Response('x'))))).headers.get('cache-control')).toBe('no-store');
    expect((await proxy(req('/api/x'), envWith(vi.fn(async () => new Response('x', { headers: { 'cache-control': 'private, max-age=0' } }))))).headers.get('cache-control')).toBe('private, max-age=0');
  });
  it('falha do Worker vira 502 genérico, sem vazar o erro', async () => {
    const res = await proxy(req('/api/x'), envWith(vi.fn(async () => { throw new Error('segredo-interno do banco'); }))); const t = await res.text();
    expect(res.status).toBe(502); expect(t).not.toContain('segredo-interno'); expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Proxy do Pages + Worker REAL: sessão, CSRF, cookies e links públicos pelo mesmo host', () => {
  let srv: Server; let hit: (path: string, init?: RequestInit & { cookie?: string; csrf?: string; origin?: string | null }) => Promise<Response>;
  const setup = (workerEnv = 'staging', pagesEnv = 'staging') => {
    srv = makeServer(); srv.env.ALLOWED_ORIGINS = HOST; (srv.env as { APP_ENV?: string }).APP_ENV = workerEnv;
    const penv = envWith(r => srv.handle(r, srv.env), pagesEnv);
    hit = (path, init = {}) => proxy(req(path, { ...init, headers: { ...(init.origin === null ? {} : { origin: init.origin ?? HOST }), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}), ...((init.body ? { 'content-type': 'application/json' } : {})) } }), penv);
  };
  const login = async (email: string) => {
    await srv.issueFor(email);
    expect((await hit('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) })).status).toBe(202);
    const res = await hit('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email, code: srv.mail.lastCode(), deviceLabel: 'Teste' }) }); expect(res.status).toBe(200);
    return { res, cookie: res.headers.get('set-cookie')!, csrf: ((await res.clone().json()) as { csrfToken: string }).csrfToken };
  };
  beforeEach(() => setup());

  it('cookie de primeira parte: __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, sem Domain; respostas autenticadas sem cache', async () => {
    const { res, cookie } = await login('ana@exemplo.com');
    expect(cookie).toMatch(/^__Host-dabi_session=[A-Za-z0-9_-]{20,};/); for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(a); expect(cookie).not.toMatch(/Domain=/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const s = cookie.split(';')[0]; const me = await hit('/api/auth/session', { cookie: s }); expect(me.status).toBe(200); expect(me.headers.get('cache-control')).toBe('no-store');
    expect((await hit('/api/sync?since=0', { cookie: s })).headers.get('cache-control')).toBe('no-store');
  });
  it('fluxo completo pelo proxy: sincronizar, CSRF obrigatório, origem obrigatória, logout revoga', async () => {
    const { cookie, csrf } = await login('ana@exemplo.com'); const s = cookie.split(';')[0]; const body = JSON.stringify(emptyPush(0));
    expect((await hit('/api/sync/push', { method: 'POST', body, cookie: s, csrf })).status).toBe(200);
    expect((await hit('/api/sync/push', { method: 'POST', body, cookie: s })).status).toBe(403); // sem CSRF
    expect((await hit('/api/sync/push', { method: 'POST', body, cookie: s, csrf: 'errado' })).status).toBe(403);
    expect((await hit('/api/sync/push', { method: 'POST', body, cookie: s, csrf, origin: 'https://evil.example' })).status).toBe(403);
    expect((await hit('/api/sync/push', { method: 'POST', body, cookie: s, csrf, origin: null })).status).toBe(403);
    expect((await hit('/api/sync/push', { method: 'POST', body, csrf })).status).toBe(401); // sem cookie
    expect((await hit('/api/auth/logout', { method: 'POST', cookie: s, csrf })).status).toBe(200);
    expect((await hit('/api/sync?since=0', { cookie: s })).status).toBe(401);
  });
  it('o IP do cliente chega ao Worker (limites por IP continuam por cliente, não por borda)', async () => {
    const seen: (string | null)[] = []; const penv = envWith(async r => { seen.push(r.headers.get('cf-connecting-ip')); return srv.handle(r, srv.env); });
    await proxy(req('/api/auth/session', { headers: { 'cf-connecting-ip': '198.51.100.9' } }), penv); expect(seen).toEqual(['198.51.100.9']);
  });
  it('rota administrativa pelo proxy: usuário comum 403; sem cookie 401', async () => {
    const { cookie, csrf } = await login('ana@exemplo.com'); const s = cookie.split(';')[0];
    expect((await hit('/api/admin/me', { cookie: s })).status).toBe(403); expect((await hit('/api/admin/customers', { method: 'POST', body: '{"email":"x@exemplo.com"}', cookie: s, csrf })).status).toBe(403); expect((await hit('/api/admin/me')).status).toBe(401);
  });
  it('links públicos de orçamento continuam abertos pelo mesmo host (/o/:id e /api/quotes/:id), sem cookie, sem cache e com CSP restritiva; revogado = 410', async () => {
    const { cookie, csrf } = await login('ana@exemplo.com'); const s = cookie.split(';')[0];
    const made = await hit('/api/quotes', { method: 'POST', cookie: s, csrf, body: JSON.stringify({ version: 1, quoteNumber: '001', businessName: 'Doces da Ana', issuedAt: '2026-11-11', items: [{ description: 'Bolo', quantity: 1, unitPriceCents: 5000 }] }) }); expect(made.status).toBe(201);
    const { id, path } = await made.json() as { id: string; path: string }; expect(path).toBe(`/o/${id}`);
    const page = await hit(`/o/${id}`, { origin: null }); expect(page.status).toBe(200); expect(await page.text()).toContain('Doces da Ana'); expect(page.headers.get('cache-control')).toBe('no-store'); expect(page.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(page.headers.get('set-cookie')).toBeNull();
    expect((await hit(`/api/quotes/${id}`, { origin: null })).status).toBe(200);
    expect((await hit('/o/abcdefghijklmnopqrstuv', { origin: null })).status).toBe(404); expect((await hit('/o/AB', { origin: null })).status).toBe(404);
    expect((await hit('/o/ORC-K7M42P', { origin: null })).status).toBe(404); // o código de atendimento nunca abre nada
    expect((await hit(`/api/quotes/${id}`, { method: 'DELETE', cookie: s, csrf })).status).toBe(200);
    expect((await hit(`/o/${id}`, { origin: null })).status).toBe(410);
  });
  it('pelo Pages, o Worker de OUTRO ambiente recusa tudo (421) e nada é gravado', async () => {
    setup('production', 'staging'); await srv.issueFor('ana@exemplo.com');
    for (const [p, m] of [['/api/auth/request-code', 'POST'], ['/api/auth/session', 'GET'], ['/o/abcdefghijklmnopqrstuv', 'GET']] as const) expect((await hit(p, { method: m, ...(m === 'POST' ? { body: '{"email":"ana@exemplo.com"}' } : {}) })).status, p).toBe(421);
    expect(srv.mail.outbox).toHaveLength(0); expect(srv.table('auth_codes')).toHaveLength(0);
  });
  it('um cliente não escapa da guarda mandando X-Dabi-Expect-Env do ambiente "certo"', async () => {
    setup('production', 'staging'); expect((await hit('/api/auth/session', { headers: { 'x-dabi-expect-env': 'production' } } as never)).status).toBe(421);
  });
  it('sem a guarda configurada no Worker (APP_ENV ausente) o comportamento é o de sempre', async () => { setup('', 'staging'); (srv.env as { APP_ENV?: string }).APP_ENV = undefined; expect((await hit('/api/auth/session')).status).toBe(401); });
});

describe('Navegação SPA e publicação (arquivos gerados)', () => {
  const script = resolve('scripts/generate-headers.mjs');
  const gen = (api?: string) => { const dir = mkdtempSync(join(tmpdir(), 'pg-')); mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist/index.html'), '<div id="root"></div>'); execFileSync('node', [script], { cwd: dir, env: { PATH: process.env.PATH ?? '', ...(api !== undefined ? { VITE_API_URL: api } : {}) }, stdio: 'pipe' }); return dir; };
  it('VITE_API_URL=same-origin gera CSP só com \'self\' (antes quebrava o build)', () => {
    const dir = gen('same-origin'); const h = execFileSync('cat', [join(dir, 'dist/_headers')], { encoding: 'utf8' }); expect(h).toContain("connect-src 'self';"); expect(h.split('connect-src')[1].split(';')[0]).not.toMatch(/https?:/);
  });
  it('_routes.json: Functions só em /api/* e /o/*; o resto (incluindo /admin) é estático', () => {
    const dir = gen('same-origin'); const r = JSON.parse(execFileSync('cat', [join(dir, 'dist/_routes.json')], { encoding: 'utf8' })); expect(r).toEqual({ version: 1, include: ['/api/*', '/o/*'], exclude: [] });
    expect(r.include.some((p: string) => p === '/admin' || p === '/admin/*' || p === '/*')).toBe(false);
  });
  it('validação do dist: aprova o gerado; reprova 404.html (desligaria o SPA), _routes errado e segredo/endereço embutido', () => {
    const dir = gen('same-origin'); const ok = (d: string) => validateDist(join(d, 'dist'), resolve('.'));
    expect(ok(dir)).toEqual([]);
    writeFileSync(join(dir, 'dist/404.html'), 'x'); expect(ok(dir).join()).toContain('404.html'); execFileSync('rm', [join(dir, 'dist/404.html')]);
    writeFileSync(join(dir, 'dist/_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] })); expect(ok(dir).join()).toContain('_routes.json'); writeFileSync(join(dir, 'dist/_routes.json'), JSON.stringify({ version: 1, include: ['/api/*', '/o/*'], exclude: [] }));
    writeFileSync(join(dir, 'dist/app.js'), 'fetch("https://dabi-orcamentos-staging.moyses-adm.workers.dev")'); expect(ok(dir).join()).toContain('Worker'); writeFileSync(join(dir, 'dist/app.js'), 'const k="re_ABCDEFGHIJKLMNOPQRSTUVWX"'); expect(ok(dir).join()).toContain('segredo');
  });
});

describe('Ambientes separados (script de publicação)', () => {
  it('ambiente é obrigatório e sem padrão; staging e produção usam projetos e Workers diferentes', () => {
    expect(parseArgs(['deploy']).ok).toBe(false); expect(parseArgs(['deploy', 'prod']).ok).toBe(false); expect(parseArgs(['publish', 'staging']).ok).toBe(false);
    expect(ENVIRONMENTS.staging.project).not.toBe(ENVIRONMENTS.production.project); expect(ENVIRONMENTS.staging.worker).not.toBe(ENVIRONMENTS.production.worker);
    expect(ENVIRONMENTS.staging.worker).toContain('staging'); expect(ENVIRONMENTS.production.worker).not.toContain('staging');
  });
  it('sem --publish nada é publicado; publicar em produção exige confirmação com o nome do projeto', () => {
    expect(parseArgs(['deploy', 'staging'])).toMatchObject({ ok: true, plan: { publish: false } });
    expect(parseArgs(['deploy', 'staging', '--publish'])).toMatchObject({ ok: true, plan: { publish: true, config: { project: 'dabi-preco-certo-staging' } } });
    expect(parseArgs(['deploy', 'production', '--publish']).ok).toBe(false); expect(parseArgs(['deploy', 'production', '--publish', '--confirm-production', 'dabi-preco-certo-staging']).ok).toBe(false);
    expect(parseArgs(['deploy', 'production', '--publish', '--confirm-production', 'dabi-preco-certo'])).toMatchObject({ ok: true, plan: { publish: true, config: { project: 'dabi-preco-certo' } } });
    expect(parseArgs(['deploy', 'staging', '--confirm-production', 'x']).ok).toBe(false); expect(parseArgs(['build', 'staging', '--publish']).ok).toBe(false);
  });
});
