import { asOrder } from '../helpers/orders';
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadData, saveData, saveSyncMeta } from '../../src/storage/db';
import type { DataSet } from '../../src/domain/types';
import { emptyMeta } from '../../src/sync/engine';
import { createFakeBroadcast, createFakeLocks } from '../helpers/locks';
import { resetStorage } from './setup';

// Duas abas = duas cópias independentes do aplicativo (estado próprio) sobre o MESMO IndexedDB, como duas abas do mesmo navegador.
vi.mock('../../src/sync/retry', () => ({ retryDelayMs: (n: number) => 60 * 2 ** Math.min(n, 3), WAKE_MIN_INTERVAL_MS: 100, WAKE_MIN_INTERVAL_FAILING_MS: 20, DEBOUNCE_MS: 100 }));

const ing = (id: string, price = 6) => ({ id, name: `Ingrediente ${id}`, unit: 'g' as const, purchaseQuantity: 1000, purchasePrice: price });
const base = (extra: Partial<DataSet> = {}): DataSet => ({ schemaVersion: 3, settings: { cupSizeMl: 240, businessName: 'Doces' }, ingredients: [ing('a'), ing('b')],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'a', quantity: 100, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
  orders: [asOrder({ id: 'o1', quoteCode: 'ORC-K7M42P', customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 100, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z' })], ...extra });

let locks: ReturnType<typeof createFakeLocks>, BC: ReturnType<typeof createFakeBroadcast>, n = 0;
type Tab = { id: string; c: HTMLElement; close(): void };
const tabs: Tab[] = [];
beforeEach(async () => { await resetStorage(); window.history.replaceState({}, '', '/'); locks = createFakeLocks(); BC = createFakeBroadcast(); vi.stubGlobal('BroadcastChannel', BC); vi.stubGlobal('confirm', () => true); });
afterEach(() => { for (const t of tabs.splice(0)) t.close(); Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); });

async function openTab(opts: { webLocks?: boolean; api?: boolean } = {}): Promise<Tab> {
  const id = `aba${++n}`;
  Object.defineProperty(navigator, 'locks', { value: opts.webLocks === false ? undefined : locks.forTab(id), configurable: true }); // lido ao carregar o módulo: cada aba tem a sua visão
  vi.resetModules(); vi.stubEnv('VITE_API_URL', opts.api ? 'https://api.exemplo.test' : ''); vi.stubEnv('VITE_QUOTES_API_URL', '');
  const { default: App } = await import('../../src/App');
  const c = document.createElement('div'); document.body.appendChild(c); const view = render(<App />, { container: c });
  await waitFor(() => expect(within(c).queryByText('Carregando seus dados…')).toBeNull());
  const tab: Tab = { id, c, close() { locks.closeTab(id); view.unmount(); c.remove(); } }; tabs.push(tab); return tab;
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 120)); });
const banner = (t: Tab) => within(t.c).queryByRole('region', { name: 'Modo de consulta' });
const nav = async (t: Tab, name: string) => { await userEvent.setup().click(within(within(t.c).getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const editPrice = async (t: Tab, name: string, price: string) => {
  const u = userEvent.setup(); await nav(t, 'Ingredientes'); await u.click(within(t.c).getByRole('button', { name: `Editar ${name}` }));
  fireEvent.change(within(t.c).getByLabelText('Preço pago (R$)'), { target: { value: price } }); await u.click(within(t.c).getByRole('button', { name: /Salvar alterações/ }));
};
const disk = async () => loadData();
const price = async (id: string) => (await disk()).ingredients.find(i => i.id === id)?.purchasePrice;

describe('Duas abas (Web Locks): uma edita, a outra consulta', () => {
  it('A: duas abas sem alterações — a primeira edita; a segunda mostra o aviso e não grava nada', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    expect(banner(A)).toBeNull(); expect(banner(B)).not.toBeNull(); expect(within(B.c).getByRole('button', { name: 'Editar nesta aba' })).toBeTruthy();
    const before = JSON.stringify(await disk()); await editPrice(B, 'Ingrediente a', '99');
    expect(await screen.findByText(/modo de consulta/i)).toBeTruthy(); expect(JSON.stringify(await disk())).toBe(before); // a tentativa foi recusada e avisada
  }, 30000);

  it('B/C: a edição da aba A aparece na aba B sem recarregar; ao assumir, B edita OUTRO ingrediente e as duas edições ficam no disco', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await editPrice(A, 'Ingrediente a', '9'); await within(A.c).findByText(/Ingrediente atualizado/); await waitFor(async () => expect(await price('a')).toBe(9));
    await nav(B, 'Ingredientes'); await waitFor(() => expect(within(B.c).getByText('Ingrediente a', { selector: 'td' }).closest('tr')!.textContent).toMatch(/9,00/)); // chegou sem recarregar (aviso entre abas)
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Editar nesta aba' })); await settle();
    expect(banner(B)).toBeNull(); expect(banner(A)).not.toBeNull(); // os papéis trocaram
    await editPrice(B, 'Ingrediente b', '7'); await within(B.c).findByText(/Ingrediente atualizado/); await waitFor(async () => expect(await price('b')).toBe(7));
    expect(await price('a')).toBe(9); // a edição da aba A NÃO foi apagada (antes da correção, ficava 6)
    await nav(A, 'Ingredientes'); await waitFor(() => expect(within(A.c).getByText('Ingrediente b', { selector: 'td' }).closest('tr')!.textContent).toMatch(/7,00/));
  }, 40000);

  it('D: o MESMO ingrediente em sequência (A → B): vale a última edição e nada fica pela metade', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await editPrice(A, 'Ingrediente a', '9'); await waitFor(async () => expect(await price('a')).toBe(9));
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Editar nesta aba' })); await settle();
    await editPrice(B, 'Ingrediente a', '5'); await waitFor(async () => expect(await price('a')).toBe(5));
    expect((await disk()).ingredients).toHaveLength(2);
  }, 40000);

  it('I: o editor fecha — a aba que esperava assume sozinha, com os dados mais recentes, e pode editar', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await editPrice(A, 'Ingrediente a', '9'); await waitFor(async () => expect(await price('a')).toBe(9));
    A.close(); await settle(); await settle();
    expect(banner(B)).toBeNull(); // assumiu
    await editPrice(B, 'Ingrediente b', '7'); await waitFor(async () => expect(await price('b')).toBe(7)); expect(await price('a')).toBe(9);
  }, 40000);

  it('uma aba aberta depois enxerga tudo o que já foi gravado (persistência após recarregar)', async () => {
    await saveData(base()); const A = await openTab(); await settle(); await editPrice(A, 'Ingrediente a', '9'); await waitFor(async () => expect(await price('a')).toBe(9));
    A.close(); const C = await openTab(); await settle(); await nav(C, 'Ingredientes');
    expect(within(C.c).getByText('Ingrediente a', { selector: 'td' }).closest('tr')!.textContent).toMatch(/9,00/); expect(banner(C)).toBeNull();
  }, 30000);

  it('Configurações e Backup só funcionam na aba que edita (a consulta mostra uma explicação, sem ações)', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await nav(B, 'Backup'); expect(within(B.c).getByText(/só pode ser usada na aba que está editando/)).toBeTruthy(); expect(within(B.c).queryByRole('button', { name: /Restaurar/ })).toBeNull();
    await nav(A, 'Backup'); expect(within(A.c).queryByText(/só pode ser usada na aba/)).toBeNull();
  }, 30000);
});

describe('Dinheiro entre abas (cenários E, F, G)', () => {
  const pay = async (t: Tab, amount: string) => {
    const u = userEvent.setup(); await nav(t, 'Pedidos'); await u.click(within(t.c).getByRole('button', { name: 'Ver detalhes' })); await u.click(within(t.c).getByRole('button', { name: /^Registrar recebimento$/ }));
    fireEvent.change(within(t.c).getByLabelText('Valor recebido (R$)'), { target: { value: amount } }); fireEvent.change(within(t.c).getByLabelText('Data do recebimento'), { target: { value: '2026-11-12' } });
    await u.click(within(t.c).getAllByRole('button', { name: /Registrar recebimento/ }).at(-1)!); await within(t.c).findByText('Recebimento registrado.');
  };
  const paymentsOnDisk = async () => ((await disk()).orders[0].payments ?? []).map(p => p.amount);

  it('F: A e B registram recebimentos DIFERENTES na mesma encomenda: os dois ficam, sem duplicar e sem passar do total', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await pay(A, '30'); await waitFor(async () => expect(await paymentsOnDisk()).toEqual([30]));
    await nav(B, 'Pedidos'); await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Ver detalhes' })); await waitFor(() => expect(within(B.c).getByText('Saldo pendente').parentElement?.textContent).toMatch(/70,00/)); // B já enxerga o recebimento de A
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Editar nesta aba' })); await settle();
    await pay(B, '20'); await waitFor(async () => expect(await paymentsOnDisk()).toEqual([30, 20]));
    const o = (await disk()).orders[0]; expect(new Set(o.payments!.map(p => p.id)).size).toBe(2); expect(o.payments!.reduce((s, p) => s + p.amount, 0)).toBe(50);
  }, 40000);

  it('E: A registra um recebimento e, depois de assumir, B edita a encomenda: o recebimento de A continua lá', async () => {
    await saveData(base()); const A = await openTab(); await settle(); const B = await openTab(); await settle();
    await pay(A, '30'); await waitFor(async () => expect(await paymentsOnDisk()).toEqual([30]));
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Editar nesta aba' })); await settle();
    const u = userEvent.setup(); await nav(B, 'Pedidos'); await u.click(within(B.c).getByRole('button', { name: 'Ver detalhes' })); await u.click(within(B.c).getByRole('button', { name: /Editar/ }));
    await u.clear(within(B.c).getByLabelText('Nome do cliente')); await u.type(within(B.c).getByLabelText('Nome do cliente'), 'Ana Paula'); await u.click(within(B.c).getByRole('button', { name: /Salvar alterações/ }));
    await waitFor(async () => expect((await disk()).orders[0].customer).toBe('Ana Paula'));
    expect(await paymentsOnDisk()).toEqual([30]); expect((await disk()).orders[0].quoteCode).toBe('ORC-K7M42P'); // recebimento e código preservados
  }, 40000);

  it('G: reutilizar o mesmo identificador de recebimento é recusado (idempotência), em qualquer aba', async () => {
    const { addPayment } = await import('../../src/domain/payments'); const d = base();
    const once = addPayment(d, 'o1', { id: 'p-fixo', amount: 30, receivedAt: '2026-11-12' });
    expect(() => addPayment(once, 'o1', { id: 'p-fixo', amount: 30, receivedAt: '2026-11-12' })).toThrow(/duplicado/i);
  });
});

describe('Sem Web Locks (navegador antigo): a versão do documento impede qualquer sobrescrita silenciosa', () => {
  const blobText: string[] = [];
  beforeEach(() => { blobText.length = 0; vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { void b.text().then(t => blobText.push(t)); return 'blob:x'; }, revokeObjectURL: () => undefined })); });

  it('C (a falha original): B, desatualizada, tenta gravar — a gravação é RECUSADA, nada de A é apagado e as alterações de B ficam disponíveis', async () => {
    await saveData(base()); const A = await openTab({ webLocks: false }); await settle(); const B = await openTab({ webLocks: false }); await settle();
    expect(banner(A)).toBeNull(); expect(banner(B)).toBeNull(); // sem exclusão mútua, as duas aparecem como editoras
    await editPrice(A, 'Ingrediente a', '9'); await waitFor(async () => expect(await price('a')).toBe(9));
    await editPrice(B, 'Ingrediente b', '7'); // B ainda tem os dados antigos na memória
    const alert = await within(B.c).findByRole('alert'); expect(alert.textContent).toMatch(/foram alterados em outra aba/); expect(alert.textContent).toMatch(/não foram salvas/);
    expect(await price('a')).toBe(9); expect(await price('b')).toBe(6); // nada foi sobrescrito; a edição de B não entrou pela metade
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Baixar cópia das minhas alterações' }));
    await waitFor(() => expect(blobText.length).toBe(1)); expect(JSON.parse(blobText[0]).ingredients.find((i: { id: string }) => i.id === 'b').purchasePrice).toBe(7); // as alterações de B não se perderam
  }, 40000);

  it('depois de "Carregar os dados atuais", B vê o que A gravou e volta a poder editar', async () => {
    await saveData(base()); const A = await openTab({ webLocks: false }); await settle(); const B = await openTab({ webLocks: false }); await settle();
    await editPrice(A, 'Ingrediente a', '9'); await waitFor(async () => expect(await price('a')).toBe(9)); await editPrice(B, 'Ingrediente b', '7'); await within(B.c).findByRole('alert');
    await userEvent.setup().click(within(B.c).getByRole('button', { name: 'Carregar os dados atuais' })); await settle();
    expect(within(B.c).queryByRole('alert')).toBeNull();
    await editPrice(B, 'Ingrediente b', '7'); await waitFor(async () => expect(await price('b')).toBe(7)); expect(await price('a')).toBe(9);
  }, 40000);
});

describe('Sincronização com a nuvem, contas e requisições', () => {
  const SESSION = (id: string) => ({ user: { id, email: `${id}@exemplo.com` }, csrfToken: 'csrf', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let who = 'usr_1'; let calls: string[] = [];
  const stubApi = () => { calls = []; vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { const p = url.replace('https://api.exemplo.test', ''); calls.push(`${init.method ?? 'GET'} ${p.split('?')[0]}`);
    if (p === '/api/auth/session') return json(200, SESSION(who)); if (p.startsWith('/api/sync/v2?')) return json(200, { protocol: 2, revision: 1, ingredients: [], recipes: [], orders: [] }); if (p === '/api/sync/v2/push') return json(200, { revision: 2, changed: true }); return json(404, {}); })); };
  const syncs = () => calls.filter(c => c.includes('/api/sync/v2'));

  it('só a aba que edita sincroniza: a aba em consulta não faz nenhuma requisição de sincronização (nem ao ganhar o foco)', async () => {
    stubApi(); who = 'usr_1'; await saveData({ schemaVersion: 3, ingredients: [], recipes: [], orders: [] }); await saveSyncMeta({ ...emptyMeta(), userId: 'usr_1' });
    const A = await openTab({ api: true }); await settle(); await act(async () => { await new Promise(r => setTimeout(r, 400)); }); const B = await openTab({ api: true }); await settle(); await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect(banner(B)).not.toBeNull(); const n = syncs().length; expect(n).toBeGreaterThan(0);
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise(r => setTimeout(r, 400)); });
    expect(syncs().length - n).toBe(1); // um retorno de foco = UMA verificação (da aba que edita), não duas
    void A;
  }, 40000);

  it('J: a aba que assume depois de a conta ter mudado verifica a sessão ANTES de sincronizar e NÃO mistura dados de contas', async () => {
    stubApi(); who = 'usr_1'; await saveData({ schemaVersion: 3, ingredients: [], recipes: [], orders: [] }); await saveSyncMeta({ ...emptyMeta(), userId: 'usr_1' });
    const A = await openTab({ api: true }); await settle(); await act(async () => { await new Promise(r => setTimeout(r, 400)); }); const B = await openTab({ api: true }); await settle();
    who = 'usr_2'; // o cookie (compartilhado) passou a ser de outra conta
    const mark = calls.length; A.close(); await settle(); await settle(); await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    const after = calls.slice(mark); expect(after[0]).toBe('GET /api/auth/session'); // a sessão é verificada primeiro
    expect(after.filter(c => c.includes('/api/sync/v2'))).toEqual([]); // e, como o aparelho é da conta anterior, nada é baixado nem enviado
    expect(banner(B)).toBeNull(); expect((await disk()).ingredients).toHaveLength(0); // os dados locais continuam como estavam (nada da conta nova entrou)
  }, 40000);

  it('sem polling: com duas abas abertas por 8 h, nenhuma requisição é feita por temporizador', async () => {
    stubApi(); who = 'usr_1'; await saveData({ schemaVersion: 3, ingredients: [], recipes: [], orders: [] }); await saveSyncMeta({ ...emptyMeta(), userId: 'usr_1' });
    await openTab({ api: true }); await openTab({ api: true }); await settle(); await act(async () => { await new Promise(r => setTimeout(r, 500)); }); const n = calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(8 * 3_600_000); }); vi.useRealTimers();
    expect(calls.length).toBe(n);
  }, 40000);
});
