// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorage } from './setup';

// Tempos curtos só nos testes (em produção: 5 s, 10 s, 20 s… até 2 min).
vi.mock('../../src/sync/retry', () => ({ retryDelayMs: (n: number) => 60 * 2 ** Math.min(n, 3), WAKE_MIN_INTERVAL_MS: 100, WAKE_MIN_INTERVAL_FAILING_MS: 20, DEBOUNCE_MS: 100 }));

const BASE = 'https://api.exemplo.test';
const SESSION = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Server = { offline: boolean; hang: boolean; pushes: { upserts: { ingredients: { name: string; purchasePrice: number }[] } }[]; pulls: number };
function fakeServer(): Server {
  const s: Server = { offline: false, hang: false, pushes: [], pulls: 0 };
  let revision = 0; const store = new Map<string, { rev: number; data: unknown }>();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (s.offline) throw new TypeError('Failed to fetch'); // o navegador não emite nenhum evento `online` ao voltar
    const path = url.replace(BASE, '');
    if (path === '/api/auth/session') return json(200, SESSION);
    if (path.startsWith('/api/sync/v2?')) {
      s.pulls++; const since = Number(new URL(url).searchParams.get('since'));
      return json(200, { protocol: 2, revision, ingredients: [...store].filter(([, v]) => v.rev > since).map(([id, v]) => ({ id, rev: v.rev, deleted: false, data: v.data })), recipes: [], orders: [] });
    }
    if (path === '/api/sync/v2/push') {
      const body = JSON.parse(String(init.body)); s.pushes.push(body); revision++;
      for (const i of body.upserts.ingredients as { id: string }[]) store.set(i.id, { rev: revision, data: i });
      return json(200, { revision, changed: true });
    }
    return json(404, {});
  }));
  return s;
}
async function boot() {
  vi.resetModules(); vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', '');
  const { default: App } = await import('../../src/App');
  const r = render(<App />);
  await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
  return r;
}
const nav = async (u: ReturnType<typeof userEvent.setup>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const dot = () => screen.getByRole('button', { name: /^Sincronização:/ });
const dotText = () => dot().getAttribute('aria-label') ?? '';
const addIngredient = async (u: ReturnType<typeof userEvent.setup>, name: string, price: string) => {
  await u.type(screen.getByLabelText('Nome do ingrediente'), name);
  fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: price } });
  await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
};
const editPrice = async (u: ReturnType<typeof userEvent.setup>, name: string, price: string) => {
  await u.click(screen.getByRole('button', { name: `Editar ${name}` }));
  fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: price } });
  await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
  await screen.findByText(/Ingrediente atualizado/);
};
const lastPriceSent = (s: Server) => s.pushes.at(-1)?.upserts.ingredients.find(i => i.name === 'Farinha')?.purchasePrice;

beforeEach(async () => { await resetStorage(); });

describe('Alteração feita sem conexão', () => {
  it('fica pendente (nunca "sincronizado"), tenta de novo sozinha e confirma sem o evento `online`', async () => {
    const u = userEvent.setup(); const s = fakeServer();
    await boot(); await nav(u, 'Ingredientes');
    await addIngredient(u, 'Farinha', '6');
    await waitFor(() => expect(dotText()).toMatch(/Sincronizado/), { timeout: 4000 });
    expect(lastPriceSent(s)).toBe(6);

    s.offline = true;
    await editPrice(u, 'Farinha', '10');
    // o aviso é de salvamento LOCAL; a confirmação remota ainda não existe
    expect(screen.getByText(/Ingrediente atualizado/).textContent).not.toMatch(/sincroniz/i);
    await waitFor(() => expect(dotText()).toMatch(/Sincronização: (Sem conexão|Servidor inacessível)/), { timeout: 6000 });
    expect(dotText()).toMatch(/salvas neste dispositivo, mas ainda não foram confirmadas/);
    expect(dotText()).not.toMatch(/Sincronizado/);

    s.offline = false; // DevTools: Offline → No throttling, sem evento
    await waitFor(() => expect(lastPriceSent(s)).toBe(10), { timeout: 6000 });
    await waitFor(() => expect(dotText()).toMatch(/Sincronizado/), { timeout: 4000 });
  }, 30000);

  it('ao voltar o foco para a janela, sincroniza sem esperar o próximo retry', async () => {
    const u = userEvent.setup(); const s = fakeServer();
    await boot(); await nav(u, 'Ingredientes'); await addIngredient(u, 'Farinha', '6');
    await waitFor(() => expect(dotText()).toMatch(/Sincronizado/), { timeout: 4000 });
    const before = s.pulls;
    await new Promise(r => setTimeout(r, 150));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(s.pulls).toBeGreaterThan(before));
  }, 15000);

  it('depois de recarregar a página a alteração pendente continua guardada e é enviada ao reconectar', async () => {
    const u = userEvent.setup(); const s = fakeServer();
    const first = await boot(); await nav(u, 'Ingredientes'); await addIngredient(u, 'Farinha', '6');
    await waitFor(() => expect(dotText()).toMatch(/Sincronizado/), { timeout: 4000 });
    s.offline = true; await editPrice(u, 'Farinha', '10');
    await waitFor(() => expect(dotText()).toMatch(/Sincronização: (Sem conexão|Servidor inacessível)/), { timeout: 6000 });
    await new Promise(r => setTimeout(r, 300)); // deixa o salvamento no IndexedDB terminar
    first.unmount();

    await boot(); await nav(u, 'Ingredientes');
    expect(screen.getByText(/10,00/)).toBeTruthy(); // aberto sem rede: dados locais, sem conta confirmada, nada de "sincronizado"
    expect(screen.queryByRole('button', { name: /^Sincronização:/ })).toBeNull();
    s.offline = false; // a rede volta sem nenhum evento: a sessão é reconfirmada sozinha e a pendência é enviada
    await screen.findByRole('button', { name: /^Sincronização:/ }, { timeout: 6000 });
    await waitFor(() => expect(lastPriceSent(s)).toBe(10), { timeout: 8000 });
    await waitFor(() => expect(dotText()).toMatch(/Sincronizado/), { timeout: 4000 });
  }, 40000);

  it('requisição que nunca responde não trava a sincronização para sempre', async () => {
    const { createHttpSyncApi } = await import('../../src/sync/api');
    const never = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError'))))) as unknown as typeof fetch;
    const api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => 'x', fetchImpl: never, timeoutMs: 30 });
    await expect(api.pull(0)).rejects.toMatchObject({ kind: 'offline', message: expect.stringMatching(/a tempo/) });
  });
});
