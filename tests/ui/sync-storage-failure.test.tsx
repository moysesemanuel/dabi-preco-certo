// @vitest-environment jsdom
/** Falha ao gravar o estado da sincronização no IndexedDB: antes era silenciada (a tela dizia "Sincronizado"); agora aparece com a causa. */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorage } from './setup';

const BASE = 'https://api.exemplo.test';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };
const memory = new Map<string, string>();

beforeEach(async () => {
  memory.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear() });
  await resetStorage();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(BASE, '');
    if (path === '/api/auth/session') return json(200, session);
    if (path === '/api/sessions') return json(200, { maxSessions: 2, sessions: [] });
    if (path.startsWith('/api/sync/v2?')) return json(200, { protocol: 2, revision: 3, ingredients: [], recipes: [], orders: [], packagings: [] });
    if (path === '/api/sync/v2/push') return json(200, { revision: 4, changed: true });
    return json(404, {});
  }));
});

describe('Estado da sincronização não gravado', () => {
  it('mostra "Falha ao sincronizar" com a causa (armazenamento), sem declarar sucesso nem perda de dados', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', ''); vi.stubEnv('VITE_REQUIRE_LOGIN', 'on');
    vi.doMock('../../src/storage/db', async () => ({ ...(await vi.importActual<typeof import('../../src/storage/db')>('../../src/storage/db')), saveSyncMeta: () => Promise.reject(new DOMException('cota excedida', 'QuotaExceededError')) }));
    const { default: App } = await import('../../src/App');
    render(<App />);
    const dot = () => screen.getByRole('button', { name: /^Sincronização:/ }).getAttribute('aria-label') ?? '';
    await waitFor(() => expect(dot()).toMatch(/Falha ao sincronizar/), { timeout: 6000 });
    expect(dot()).toMatch(/armazenamento do navegador/);
    expect(dot()).not.toMatch(/Sincronizado|perd/);
    vi.doUnmock('../../src/storage/db');
  });
});
