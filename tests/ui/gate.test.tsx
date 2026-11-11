// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorage } from './setup';

// Versão comercial (VITE_REQUIRE_LOGIN=on): o app só abre com conta e licença ativa, sem apagar dados locais.
const BASE = 'https://api.exemplo.test';
const session = (license: unknown = { status: 'active', quotaActive: 100, quotaDaily: 30 }) => ({ user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type S = { signedIn: boolean; offline: boolean; license: unknown; calls: string[] };
function fakeServer(): S {
  const s: S = { signedIn: false, offline: false, license: { status: 'active', quotaActive: 100, quotaDaily: 30 }, calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (s.offline) throw new TypeError('Failed to fetch');
    const path = url.replace(BASE, ''); s.calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/auth/session') return s.signedIn ? json(200, session(s.license)) : json(401, { error: 'UNAUTHORIZED' });
    if (path === '/api/auth/request-code') return json(202, { ok: true, expiresInMinutes: 10 });
    if (path === '/api/auth/verify-code') { s.signedIn = true; return json(200, session(s.license)); }
    if (path === '/api/auth/logout') { s.signedIn = false; return json(200, { ok: true }); }
    if (path === '/api/sessions') return json(200, { maxSessions: 2, sessions: [] });
    if (path.startsWith('/api/sync?')) return json(200, { revision: 0, ingredients: [], recipes: [], orders: [] });
    if (path === '/api/sync/push') return json(200, { revision: 1, changed: true });
    return json(404, {});
  }));
  return s;
}
async function boot(opts: { requireLogin?: boolean; seed?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', '');
  vi.stubEnv('VITE_REQUIRE_LOGIN', opts.requireLogin === false ? '' : 'on');
  if (opts.seed) { const { saveData } = await import('../../src/storage/db'); await saveData({ schemaVersion: 3, ingredients: [{ id: 'i1', name: 'Farinha Local', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 }], recipes: [], orders: [] }); }
  vi.resetModules();
  const { default: App } = await import('../../src/App');
  render(<App />);
}
const hasApp = () => screen.queryByRole('navigation', { name: 'Navegação principal' }) !== null;
const memory = new Map<string, string>();
beforeEach(async () => {
  memory.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear() });
  await resetStorage(); vi.stubGlobal('confirm', () => true);
});

describe('Acesso na versão comercial', () => {
  it('sem sessão: mostra só a entrada (nenhuma navegação nem dado) e avisa que os dados locais foram preservados', async () => {
    fakeServer();
    await boot({ seed: true });
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    expect(hasApp()).toBe(false);
    expect(screen.queryByText('Farinha Local')).toBeNull();
    expect(screen.getByText(/não foram apagados/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Baixar backup/ })).toBeTruthy();
  });

  it('ao entrar, o app abre e os dados locais existentes continuam lá (e vão para a conta pelo fluxo normal)', async () => {
    const u = userEvent.setup(); const server = fakeServer();
    await boot({ seed: true });
    await u.type(await screen.findByLabelText('E-mail da compra'), 'bia@exemplo.com');
    await u.click(screen.getByRole('button', { name: 'Enviar código de acesso' }));
    await u.type(await screen.findByLabelText('Código de 8 dígitos'), '12345678');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(hasApp()).toBe(true));
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Ingredientes' }));
    expect(await screen.findByText('Farinha Local')).toBeTruthy();
    await waitFor(() => expect(server.calls).toContain('POST /api/sync/push'));
  });

  it('com sessão válida e licença ativa o app abre direto', async () => {
    const s = fakeServer(); s.signedIn = true;
    await boot({ seed: true });
    await waitFor(() => expect(hasApp()).toBe(true));
  });

  it('licença revogada: acesso indisponível, sem o app; backup e sair continuam disponíveis e nada é apagado', async () => {
    const s = fakeServer(); s.signedIn = true; s.license = { status: 'revoked', quotaActive: 100, quotaDaily: 30 };
    await boot({ seed: true });
    expect((await screen.findByRole('alert')).textContent).toContain('licença desta conta foi revogada');
    expect(hasApp()).toBe(false);
    expect(screen.getByRole('button', { name: /Baixar backup/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sair desta conta/ })).toBeTruthy();
    expect(s.calls.some(c => c.includes('/api/sync'))).toBe(false); // nada é sincronizado sem licença
  });

  it('sem internet e sem acesso anterior: não abre', async () => {
    const s = fakeServer(); s.offline = true;
    await boot({ seed: true });
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    expect(hasApp()).toBe(false);
  });

  it('sem internet, mas com acesso verificado há menos de 7 dias: abre com aviso de modo offline', async () => {
    const s = fakeServer(); s.offline = true;
    localStorage.setItem('pedidocerto.lastAccess', String(Date.now() - 2 * 86_400_000));
    await boot({ seed: true });
    await waitFor(() => expect(hasApp()).toBe(true));
    expect(screen.getByText(/Sem conexão com o servidor/)).toBeTruthy();
  });

  it('sem internet e último acesso há mais de 7 dias: não abre', async () => {
    const s = fakeServer(); s.offline = true;
    localStorage.setItem('pedidocerto.lastAccess', String(Date.now() - 8 * 86_400_000));
    await boot({ seed: true });
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    expect(hasApp()).toBe(false);
  });

  it('sessão encerrada de verdade (401, com internet) não ganha tolerância offline, mesmo com acesso recente', async () => {
    fakeServer(); localStorage.setItem('pedidocerto.lastAccess', String(Date.now()));
    await boot();
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    expect(hasApp()).toBe(false);
  });

  it('modo local (sem VITE_REQUIRE_LOGIN) continua abrindo sem conta', async () => {
    fakeServer();
    await boot({ requireLogin: false, seed: true });
    await waitFor(() => expect(hasApp()).toBe(true));
  });
});
