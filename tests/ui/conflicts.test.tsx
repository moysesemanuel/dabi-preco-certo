// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSyncMeta } from '../../src/storage/db';
import { emptyMeta } from '../../src/sync/engine';
import { resetStorage } from './setup';

vi.mock('../../src/sync/retry', () => ({ retryDelayMs: () => 60, WAKE_MIN_INTERVAL_MS: 100, WAKE_MIN_INTERVAL_FAILING_MS: 20, DEBOUNCE_MS: 100 }));

const BASE = 'https://api.exemplo.test';
const SESSION = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Ing = { id: string; name: string; purchasePrice: number };
/** Servidor de teste com revisões e verificação de base (como o Worker): enviar sobre uma versão desatualizada é recusado. */
function fakeServer() {
  const s = { offline: false, revision: 0, store: new Map<string, { rev: number; data: Ing }>(), pushes: [] as Ing[][],
    /** Outro dispositivo altera o preço direto na nuvem. */
    otherDevice(id: string, price: number) { const cur = s.store.get(id)!; s.revision++; s.store.set(id, { rev: s.revision, data: { ...cur.data, purchasePrice: price } }); } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (s.offline) throw new TypeError('Failed to fetch');
    const path = url.replace(BASE, '');
    if (path === '/api/auth/session') return json(200, SESSION);
    if (path.startsWith('/api/sync?')) { const since = Number(new URL(url).searchParams.get('since')); return json(200, { revision: s.revision, ingredients: [...s.store].filter(([, v]) => v.rev > since).map(([id, v]) => ({ id, rev: v.rev, deleted: false, data: v.data })), recipes: [], orders: [] }); }
    if (path === '/api/sync/push') {
      const body = JSON.parse(String(init.body)) as { upserts: { ingredients: Ing[] }; baseRevs: { ingredients: Record<string, number> } };
      for (const i of body.upserts.ingredients) { const cur = s.store.get(i.id); if (cur && body.baseRevs.ingredients[i.id] !== cur.rev) return json(409, { error: 'CONFLICT', conflicts: [] }); }
      s.pushes.push(body.upserts.ingredients); s.revision++;
      for (const i of body.upserts.ingredients) s.store.set(i.id, { rev: s.revision, data: i });
      return json(200, { revision: s.revision, changed: true });
    }
    return json(404, {});
  }));
  return s;
}
type Srv = ReturnType<typeof fakeServer>;
async function boot() {
  vi.resetModules(); vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', '');
  const { default: App } = await import('../../src/App');
  const r = render(<App />);
  await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
  return r;
}
const U = () => userEvent.setup();
const nav = async (u: ReturnType<typeof U>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const dotLabel = () => screen.getByRole('button', { name: /^Sincronização:/ }).getAttribute('aria-label') ?? '';
const banner = () => screen.queryByRole('region', { name: 'Conflitos de sincronização' });
async function conflictScenario(u: ReturnType<typeof U>, s: Srv) {
  const app = await boot(); await nav(u, 'Ingredientes');
  await u.type(screen.getByLabelText('Nome do ingrediente'), 'Farinha de trigo');
  fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '11' } });
  await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
  await waitFor(() => expect(dotLabel()).toMatch(/Sincronizado/), { timeout: 4000 });
  s.offline = true;                                                          // janela anônima: Network → Offline
  await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
  fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '12' } });
  await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
  await screen.findByText(/Ingrediente atualizado/);
  s.otherDevice([...s.store.keys()][0], 13);                                 // janela normal: R$ 13 já confirmado na nuvem
  s.offline = false;                                                         // reconecta sem evento `online`
  await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 6000 });
  return app;
}

beforeEach(async () => { await resetStorage(); });

describe('Conflito na interface', () => {
  it('mostra o banner persistente e o indicador âmbar, sem substituir o valor local', async () => {
    const u = U(); const s = fakeServer(); await conflictScenario(u, s);
    expect(banner()!.textContent).toMatch(/Encontramos alterações diferentes/); expect(banner()!.textContent).toMatch(/Farinha de trigo/); expect(banner()!.textContent).toMatch(/preservada/);
    expect(within(banner()!).getByRole('button', { name: /Acessar conflitos/ })).toBeTruthy();
    expect(dotLabel()).toMatch(/Conflito aguardando decisão/); expect(dotLabel()).not.toMatch(/Sincronizado/);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sincronização:/ }).className).toMatch(/conflict/));
    expect(screen.getByText(/12,00/)).toBeTruthy(); // continua R$ 12,00 na tela
    expect(s.store.get([...s.store.keys()][0])!.data.purchasePrice).toBe(13); // e a nuvem não foi sobrescrita
    await new Promise(r => setTimeout(r, 400)); expect(banner()).not.toBeNull(); // não some sozinho nem com novas sincronizações
  }, 30000);

  it('o painel compara as duas versões em formato brasileiro; Esc adia sem perder nada e devolve o foco', async () => {
    const u = U(); const s = fakeServer(); await conflictScenario(u, s);
    const open = within(banner()!).getByRole('button', { name: /Acessar conflitos/ });
    await u.click(open);
    const dlg = await screen.findByRole('dialog', { name: /Resolver conflito — Farinha de trigo/ });
    expect(within(dlg).getByRole('region', { name: 'Neste dispositivo' }).textContent).toMatch(/12,00/);
    expect(within(dlg).getByRole('region', { name: 'Na nuvem' }).textContent).toMatch(/13,00/);
    expect(within(dlg).getByText(/Alteração salva offline/)).toBeTruthy(); expect(within(dlg).getByText(/confirmada pelo servidor/)).toBeTruthy();
    expect(dlg.contains(document.activeElement)).toBe(true); // foco dentro do diálogo
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(banner()).not.toBeNull(); expect(document.activeElement).toBe(open); // foco devolvido; banner continua
  }, 30000);

  it('manter minha alteração exige confirmação, envia R$ 12 à nuvem e encerra o aviso', async () => {
    const u = U(); const s = fakeServer(); await conflictScenario(u, s);
    await u.click(within(banner()!).getByRole('button', { name: /Acessar conflitos/ }));
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getByRole('button', { name: 'Manter minha alteração' }));
    expect(s.pushes.length).toBe(1); // nada foi enviado antes da confirmação (só o envio inicial)
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(s.store.get([...s.store.keys()][0])!.data.purchasePrice).toBe(12), { timeout: 4000 });
    await waitFor(() => expect(banner()).toBeNull()); await waitFor(() => expect(dotLabel()).toMatch(/Sincronizado/), { timeout: 4000 });
  }, 30000);

  it('manter a versão da nuvem aplica R$ 13 só depois de confirmar', async () => {
    const u = U(); const s = fakeServer(); await conflictScenario(u, s);
    await u.click(within(banner()!).getByRole('button', { name: /Acessar conflitos/ }));
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getByRole('button', { name: 'Manter versão da nuvem' }));
    expect(screen.queryByText(/13,00/, { selector: 'td' })).toBeNull(); // ainda não aplicado
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(banner()).toBeNull());
    await screen.findByText(/13,00/, { selector: 'td' });
    expect(s.store.get([...s.store.keys()][0])!.data.purchasePrice).toBe(13);
  }, 30000);

  it('recarregar a página com o conflito pendente mantém o banner e o valor local', async () => {
    const u = U(); const s = fakeServer(); const app = await conflictScenario(u, s);
    await new Promise(r => setTimeout(r, 300)); // deixa o IndexedDB gravar
    app.unmount(); // F5
    await boot(); await waitFor(() => expect(banner()).not.toBeNull(), { timeout: 6000 });
    await nav(u, 'Ingredientes'); expect(screen.getByText(/12,00/)).toBeTruthy();
    expect(s.store.get([...s.store.keys()][0])!.data.purchasePrice).toBe(13);
  }, 30000);

  it('não mostra conflitos guardados de outra conta', async () => {
    const u = U(); fakeServer();
    await saveSyncMeta({ ...emptyMeta(), userId: 'usr_outra', conflicts: [{ id: 'ingredients:x:2', kind: 'ingredients', entityId: 'x', at: '2026-11-12T10:00:00Z', reason: 'edited-elsewhere', local: { id: 'x', name: 'Segredo da outra conta', purchasePrice: 1 }, server: { id: 'x', name: 'Segredo da outra conta', purchasePrice: 2 }, pending: true, serverRev: 2 }] });
    await boot(); await nav(u, 'Configurações');
    await screen.findAllByText(/outra conta/i);
    expect(banner()).toBeNull(); expect(screen.queryByText(/Segredo da outra conta/)).toBeNull(); expect(screen.queryByText(/Encontramos/)).toBeNull();
  }, 20000);
});

