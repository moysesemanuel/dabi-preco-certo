// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveData, saveSyncMeta } from '../../src/storage/db';
import type { DataSet } from '../../src/domain/types';
import { Device } from '../helpers/device';
import { makeServer, type Server, type Session } from '../helpers/server';
import { resetStorage } from './setup';

// Tempos curtos só nos testes. Em produção: pausa de 2,5 s depois de editar; foco mínimo de 15 s (3 s em falha); retry 5 s → 5 min.
vi.mock('../../src/sync/retry', () => ({ retryDelayMs: (n: number) => 60 * 2 ** Math.min(n, 3), WAKE_MIN_INTERVAL_MS: 100, WAKE_MIN_INTERVAL_FAILING_MS: 20, DEBOUNCE_MS: 100 }));

const BASE = 'https://api.exemplo.test';
const ing = (id: string, price = 6) => ({ id, name: `Ingrediente ${id}`, unit: 'g' as const, purchaseQuantity: 1000, purchasePrice: price });
const dataset = (over: Partial<DataSet> = {}, codes = true): DataSet => ({ schemaVersion: 3, settings: { cupSizeMl: 240, businessName: 'Doces' }, ingredients: [ing('a'), ing('b')],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'a', quantity: 100, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
  orders: [{ id: 'o1', ...(codes ? { quoteCode: 'ORC-K7M42P' } : {}), customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 40, deposit: 10, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', payments: [{ id: 'p1', amount: 20, receivedAt: '2026-11-12' }] }], ...over });

type Log = { t: number; method: string; path: string; inflight: number }[];
let srv: Server, session: Session, log: Log, inflight: number, maxInflight: number, offline: boolean;
const syncCalls = (kind?: 'GET' | 'POST') => log.filter(l => l.path.startsWith('/api/sync/v2') && (!kind || l.method === kind));

/** Prepara o servidor (Worker real + SQLite) e o aparelho (IndexedDB) já sincronizados e abre o app. */
async function boot(opts: { strict?: boolean; serverData?: DataSet; localData?: DataSet; serverCodes?: boolean } = {}) {
  srv = makeServer(); await srv.issueFor('bia@exemplo.com'); session = await srv.login('bia@exemplo.com', 'Aparelho local', '10.0.0.1');
  log = []; inflight = 0; maxInflight = 0; offline = false;
  const seed = new Device(srv, session); seed.edit(() => opts.serverData ?? dataset({}, true)); await seed.sync();
  if (opts.serverCodes === false) srv.db.raw.exec('UPDATE orders SET quote_code = NULL');
  const userId = (srv.db.raw.prepare('SELECT id FROM users').get() as { id: string }).id;
  await saveSyncMeta({ ...seed.meta, userId }); await saveData(opts.localData ?? seed.data);
  const real = srv.fetchFor(session); const t0 = Date.now();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(BASE, ''); const isSync = path.startsWith('/api/sync/v2'); log.push({ t: Date.now() - t0, method: init?.method ?? 'GET', path: path.split('?')[0], inflight: isSync ? ++inflight : inflight }); maxInflight = Math.max(maxInflight, inflight);
    try { if (offline) throw new TypeError('Failed to fetch'); return await real(url, init); } finally { if (isSync) inflight--; }
  }));
  vi.resetModules(); vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', '');
  const { default: App } = await import('../../src/App');
  const view = render(opts.strict ? <React.StrictMode><App /></React.StrictMode> : <App />);
  await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
  return { view, seed };
}
const idle = (ms: number) => new Promise(r => setTimeout(r, ms));
const settle = async () => { await waitFor(() => expect(screen.getByRole('button', { name: /^Sincronização:/ })).toBeTruthy(), { timeout: 5000 }); await idle(600); };
beforeEach(async () => { await resetStorage(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { vi.useRealTimers(); });

describe('Aba aberta e ociosa: sem consultas contínuas', () => {
  // Causa comprovada do "GET /api/sync a cada 2 s": em desenvolvimento (React StrictMode) a função de atualização do estado roda DUAS vezes; o app
  // guardava "o último resultado da sincronização" em uma única referência, que ficava diferente do estado; a diferença reagendava a sincronização
  // 2,5 s depois (pausa de edição), para sempre. Cada ciclo era só um pull (nada mudava).
  it.each([[false, true], [true, true], [true, false]])('StrictMode=%s, pedido com código=%s: depois do primeiro ciclo não há mais requisições', async (strict, codes) => {
    await boot({ strict, serverData: dataset({}, codes), localData: dataset({}, codes), serverCodes: codes });
    await settle(); const afterBoot = syncCalls().length;
    await idle(3200); // maior que a pausa de edição real (2,5 s): o laço antigo reaparecia a cada 2,5 s
    expect(syncCalls().length).toBe(afterBoot);
    expect(syncCalls('GET').length).toBeLessThanOrEqual(2); expect(syncCalls('POST').length).toBeLessThanOrEqual(1);
  }, 30_000);

  it('pedidos antigos (código preenchido pelo app) sincronizam UMA vez e ficam quietos, também com StrictMode', async () => {
    await boot({ strict: true, serverData: dataset({}, false), localData: dataset({}, false), serverCodes: false });
    await settle(); await idle(3200);
    expect(syncCalls('POST')).toHaveLength(1); expect(syncCalls('GET').length).toBeLessThanOrEqual(2);
    expect(srv.table('orders')[0].quote_code).toMatch(/^ORC-[A-Z2-9]{6}$/);
  }, 30_000);

  it('com um conflito pendente (nada a enviar) também fica quieto', async () => {
    srv = makeServer(); await srv.issueFor('bia@exemplo.com'); const sess = await srv.login('bia@exemplo.com', 'A', '10.0.0.1'); const sess2 = await srv.login('bia@exemplo.com', 'B', '10.0.0.2');
    const A = new Device(srv, sess), B = new Device(srv, sess2);
    A.edit(() => dataset()); await A.sync(); await B.sync();
    B.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'a' ? { ...i, purchasePrice: 13 } : i)) })); await B.sync(); // nuvem: 13
    const local = { ...A.data, ingredients: A.data.ingredients.map(i => (i.id === 'a' ? { ...i, purchasePrice: 12 } : i)) }; // aparelho: 12
    const userId = (srv.db.raw.prepare('SELECT id FROM users').get() as { id: string }).id; await saveSyncMeta({ ...A.meta, userId }); await saveData(local);
    log = []; inflight = 0; const real = srv.fetchFor(sess); vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { log.push({ t: 0, method: init?.method ?? 'GET', path: url.replace(BASE, '').split('?')[0], inflight: 0 }); return real(url, init); }));
    vi.resetModules(); vi.stubEnv('VITE_API_URL', BASE); vi.stubEnv('VITE_QUOTES_API_URL', '');
    const { default: App } = await import('../../src/App'); render(<React.StrictMode><App /></React.StrictMode>);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Conflitos de sincronização' })).not.toBeNull(), { timeout: 5000 }); // o conflito continua sendo detectado
    const n = syncCalls().length; await idle(3200); expect(syncCalls().length).toBe(n);
  }, 30_000);
});

describe('Gatilhos legítimos continuam funcionando', () => {
  it('uma edição local é sincronizada (uma pausa, um envio) e o app volta a ficar quieto', async () => {
    const u = userEvent.setup(); await boot({ strict: true }); await settle();
    const before = syncCalls('POST').length;
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Ingredientes' }));
    await u.click(screen.getByRole('button', { name: 'Editar Ingrediente a' }));
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '9' } }); await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    await waitFor(() => expect(srv.table('ingredients').find(r => r.id === 'a')?.purchase_price).toBe(9), { timeout: 5000 });
    expect(syncCalls('POST').length).toBe(before + 1);
    await idle(800); const n = syncCalls().length; await idle(1500); expect(syncCalls().length).toBe(n);
  }, 30_000);

  it('outra sessão altera um registro; ao voltar o foco para este aplicativo a mudança chega (sem recarregar)', async () => {
    const u = userEvent.setup(); const { seed } = await boot({ strict: true }); await settle();
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Ingredientes' }));
    const other = new Device(srv, await srv.login('bia@exemplo.com', 'Outro', '10.0.0.9').catch(async () => session)); other.meta = seed.meta; other.data = seed.data;
    other.edit(d => ({ ...d, ingredients: [...d.ingredients, ing('novo-da-outra-sessao')] })); expect((await other.sync()).status).toBe('synced');
    expect(screen.queryByText('Ingrediente novo-da-outra-sessao')).toBeNull(); // ocioso: nada chega sozinho (sem polling)
    await idle(200); act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText('Ingrediente novo-da-outra-sessao', {}, { timeout: 5000 })).toBeTruthy();
  }, 30_000);

  it('alternar entre abas/janelas muitas vezes não gera uma tempestade de requisições (intervalo mínimo entre verificações)', async () => {
    await boot({ strict: true }); await settle(); const n = syncCalls().length;
    for (let i = 0; i < 40; i++) { act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); } // 40 alternâncias no mesmo instante
    await idle(700);
    expect(syncCalls().length - n).toBeLessThanOrEqual(2); // o intervalo mínimo junta as alternâncias seguidas
    expect(maxInflight).toBe(1); // e nunca há dois ciclos de sincronização ao mesmo tempo
  }, 30_000);

  it('perde e recupera a conexão: tenta de novo com intervalos crescentes (backoff), sem laço, e volta a sincronizar sozinho', async () => {
    const u = userEvent.setup(); await boot({ strict: true }); await settle();
    offline = true; const n = syncCalls().length;
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Ingredientes' }));
    await u.click(screen.getByRole('button', { name: 'Editar Ingrediente b' })); fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '15' } }); await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    await idle(2600);
    const attempts = syncCalls().slice(n); expect(attempts.length).toBeGreaterThanOrEqual(3); expect(attempts.length).toBeLessThanOrEqual(8); // mocks: 60, 120, 240, 480 ms…
    const gaps = attempts.slice(1).map((a, i) => a.t - attempts[i].t); expect(gaps.at(-1)!).toBeGreaterThanOrEqual(gaps[1] ?? 0); // não encurta
    expect(maxInflight).toBe(1);
    offline = false; await waitFor(() => expect(srv.table('ingredients').find(r => r.id === 'b')?.purchase_price).toBe(15), { timeout: 8000 });
    await idle(800); const m = syncCalls().length; await idle(1500); expect(syncCalls().length).toBe(m); // recuperou e ficou quieto
  }, 40_000);
});

describe('Dados financeiros e conflitos não são afetados', () => {
  it('um recebimento enviado com resposta perdida e vários retries não é duplicado', async () => {
    srv = makeServer(); await srv.issueFor('bia@exemplo.com'); const A = new Device(srv, await srv.login('bia@exemplo.com', 'A', '10.0.0.1'));
    A.edit(() => dataset()); await A.sync();
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, payments: [...(o.payments ?? []), { id: 'p2', amount: 15, receivedAt: '2026-11-13' }] })) }));
    A.dropNextPushResponse = true; expect((await A.sync()).status).toBe('offline'); // o servidor gravou, mas a resposta se perdeu
    for (let i = 0; i < 6; i++) await A.sync();
    expect(srv.table('order_payments').map(p => p.id).sort()).toEqual(['p1', 'p2']); expect(A.meta.conflicts).toEqual([]);
  });
  it('edições simultâneas do mesmo registro continuam virando conflito pendente (nada sobrescrito)', async () => {
    srv = makeServer(); await srv.issueFor('bia@exemplo.com'); const A = new Device(srv, await srv.login('bia@exemplo.com', 'A', '10.0.0.1')), B = new Device(srv, await srv.login('bia@exemplo.com', 'B', '10.0.0.2'));
    A.edit(() => dataset()); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'a' ? { ...i, purchasePrice: 12 } : i)) })); B.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'a' ? { ...i, purchasePrice: 13 } : i)) })); await B.sync();
    await A.sync(); expect(A.meta.conflicts.filter(c => c.pending)).toHaveLength(1); expect(A.data.ingredients[0].purchasePrice).toBe(12);
  });
});

describe('Consumo estimado de uma aba (relógio simulado)', () => {
  it.each([[1, 0], [8, 0], [24, 0]])('%s h aberta e ociosa: %s requisições do temporizador; cada retorno de foco custa 1 verificação', async (hours, expected) => {
    await boot({ strict: true }); await settle(); const base = syncCalls().length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(hours * 3_600_000); });
    expect(syncCalls().length - base).toBe(expected); // sem polling: nenhum temporizador periódico
    for (let i = 0; i < 20; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(50); for (let k = 0; k < 400 && inflight > 0; k++) await vi.advanceTimersByTimeAsync(10); await vi.advanceTimersByTimeAsync(50); }); } // espera o ciclo terminar (o Worker de teste leva tempo REAL)
    expect(syncCalls().length - base).toBe(20); // 20 retornos ao app = 20 verificações (1 requisição cada), independentemente de quantas horas passaram
    process.stdout.write(`\nAba ociosa por ${hours} h: ${expected} requisições; +20 retornos de foco: 20 requisições (antes da correção, em desenvolvimento: ≈ ${Math.round(hours * 3600 / 2.5)} pulls)\n`);
  }, 60_000);
});
