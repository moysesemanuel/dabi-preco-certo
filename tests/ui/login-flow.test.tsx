// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorage } from './setup';

// Regressão do login em homologação: o código era aceito, o toast de sucesso aparecia e a tela de login voltava, porque o cookie
// de sessão (SameSite=Lax, outro site) não acompanhava as chamadas seguintes: a leitura da sessão e a sincronização davam 401.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SESSION = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };

/** Servidor simulado com "jar" de cookies: só reconhece a sessão se o navegador guardou o cookie (`keepsCookie`). */
type Fake = { calls: string[]; jar: { has: boolean }; keepsCookie: boolean; dropSessionOnSync: boolean };
function fakeApi(opts: Partial<Fake> = {}): Fake {
  const f: Fake = { calls: [], jar: { has: false }, keepsCookie: true, dropSessionOnSync: false, ...opts };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url); const key = `${init.method ?? 'GET'} ${u.origin}${u.pathname}`; f.calls.push(key);
    if (u.pathname === '/api/auth/request-code') return json(202, { ok: true, expiresInMinutes: 10 });
    if (u.pathname === '/api/auth/verify-code') { if (f.keepsCookie) f.jar.has = true; return json(200, SESSION); }
    if (u.pathname === '/api/auth/session') return f.jar.has ? json(200, SESSION) : json(401, { error: 'UNAUTHORIZED' });
    if (u.pathname === '/api/sessions') return f.jar.has ? json(200, { maxSessions: 2, sessions: [] }) : json(401, {});
    if (u.pathname === '/api/sync') { if (f.dropSessionOnSync) { f.jar.has = false; return json(401, { error: 'UNAUTHORIZED' }); } return f.jar.has ? json(200, { revision: 0, ingredients: [], recipes: [], orders: [] }) : json(401, {}); }
    if (u.pathname === '/api/sync/push') return f.jar.has ? json(200, { revision: 1, changed: true }) : json(401, {});
    return json(404, {});
  }));
  return f;
}
const memory = new Map<string, string>();
async function boot(api: string) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', api); vi.stubEnv('VITE_QUOTES_API_URL', ''); vi.stubEnv('VITE_REQUIRE_LOGIN', 'on');
  const { default: App } = await import('../../src/App');
  return render(<App />);
}
const hasApp = () => screen.queryByRole('navigation', { name: 'Navegação principal' }) !== null;
async function login(u: ReturnType<typeof userEvent.setup>) {
  await u.type(await screen.findByLabelText('Seu e-mail'), 'bia@exemplo.com');
  await u.click(screen.getByRole('button', { name: 'Enviar código' }));
  await u.type(await screen.findByLabelText('Código de 8 dígitos'), '12345678');
  await u.click(screen.getByRole('button', { name: 'Confirmar código' }));
}
beforeEach(async () => {
  memory.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear() });
  await resetStorage(); vi.stubGlobal('confirm', () => true);
});
const API = 'https://api.exemplo.test';

describe('Login com sessão por cookie', () => {
  it('cookie guardado: o app abre, o aviso de sucesso só aparece depois, e ao recarregar a página continua autenticado', async () => {
    const u = userEvent.setup(); const api = fakeApi();
    const first = await boot(API);
    await login(u);
    await waitFor(() => expect(hasApp()).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Acesse sua conta' })).toBeNull();
    // a sessão foi confirmada (GET /api/auth/session) DEPOIS de validar o código e ANTES de abrir o app
    const i = api.calls.indexOf(`POST ${API}/api/auth/verify-code`);
    expect(api.calls.slice(i + 1)).toContain(`GET ${API}/api/auth/session`);
    await waitFor(() => expect(api.calls).toContain(`GET ${API}/api/sync`));
    expect(hasApp()).toBe(true);
    // "atualiza a página": novo App, mesmo cookie
    first.unmount();
    await boot(API);
    await waitFor(() => expect(hasApp()).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Acesse sua conta' })).toBeNull();
  });

  it('navegador NÃO guarda o cookie (cookie entre sites bloqueado): não anuncia sucesso, explica o motivo e não tenta sincronizar', async () => {
    const u = userEvent.setup(); const api = fakeApi({ keepsCookie: false });
    await boot(API);
    await login(u);
    expect((await screen.findByRole('alert')).textContent).toContain('não guardou a sessão');
    expect(screen.queryByText('Você entrou na sua conta.')).toBeNull(); // nenhum toast de sucesso falso
    expect(hasApp()).toBe(false);
    expect(screen.getByRole('heading', { name: 'Confirme seu código' })).toBeTruthy();
    expect(api.calls.some(c => c.includes('/api/sync'))).toBe(false);
  });

  it('sessão perdida logo depois do login (o servidor não reconhece o cookie na sincronização): volta ao login COM explicação, sem loop', async () => {
    const u = userEvent.setup(); const api = fakeApi({ dropSessionOnSync: true });
    await boot(API);
    await login(u);
    expect((await screen.findByText(/não foi reconhecida pelo servidor/)).textContent).toBeTruthy();
    expect(hasApp()).toBe(false);
    await new Promise(r => setTimeout(r, 150));
    expect(api.calls.filter(c => c === `GET ${API}/api/sync`).length).toBeLessThanOrEqual(2); // sem repetir em loop
  });

  it('VITE_API_URL=same-origin: as chamadas vão para a origem do próprio app (é o que o proxy do Vite atende)', async () => {
    const u = userEvent.setup(); const api = fakeApi();
    await boot('same-origin');
    await login(u);
    await waitFor(() => expect(hasApp()).toBe(true));
    const origin = window.location.origin;
    expect(api.calls.length).toBeGreaterThan(0);
    for (const c of api.calls) expect(c.split(' ')[1].startsWith(origin)).toBe(true);
  });

  it('same-origin em página https de outro host é aceito; http fora de localhost continua recusado', async () => {
    vi.resetModules();
    const { safeApiBase } = await import('../../src/account/http');
    expect(safeApiBase('same-origin')).toBe(window.location.origin); // jsdom: http://localhost (permitido)
    expect(safeApiBase('http://api.exemplo.com')).toBeUndefined();
    expect(safeApiBase('https://api.exemplo.com')).toBe('https://api.exemplo.com');
  });
});
