// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { legacyQuoteCode } from '../../shared/quoteCode';
import { loadData, saveData } from '../../src/storage/db';
import { resetStorage } from './setup';

const user = () => userEvent.setup();
const nav = async (u: ReturnType<typeof user>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const loaded = async () => { await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull()); };
beforeEach(async () => { await resetStorage(); vi.stubGlobal('confirm', () => true); });

const order = (id: string, customer: string, status: string, recipeId: string, over: Record<string, unknown> = {}) => ({ id, customer, recipeId, quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status, createdAt: '2026-11-11T10:00:00.000Z', ...over });
const seed = (orders: unknown[]) => saveData({ schemaVersion: 3, settings: { cupSizeMl: 240, businessName: 'Doces da Bia' }, ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6 }],
  recipes: [{ id: 'bolo', name: 'Bolo de Cenoura', yield: 10, items: [{ ingredientId: 'f', quantity: 500, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }, { id: 'brig', name: 'Brigadeiro Gourmet', yield: 10, items: [{ ingredientId: 'f', quantity: 100, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }], orders } as never);
const three = () => seed([order('o1', 'Ana Martins', 'Orçamento', 'bolo', { quoteCode: 'ORC-K7M42P' }), order('o2', 'José Conceição', 'Confirmado', 'brig', { quoteCode: 'ORC-X9T3QW' }), order('o3', 'Maria Antônia', 'Entregue', 'bolo', { quoteCode: 'ORC-K7N8RB' })]);
const cards = () => screen.getAllByText(/^ORC-/, { selector: '.quote-code-text' }).map(e => e.textContent);
const search = () => screen.getByRole('button', { name: /Pesquisar/ });

describe('Código no card', () => {
  it('aparece acima do nome do cliente, com ação de copiar e confirmação acessível', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    const code = screen.getByText('ORC-K7M42P'); const row = code.closest('li')!;
    expect(row.textContent).toMatch(/ORC-K7M42P.*Ana Martins/); // código antes do cliente
    await u.click(screen.getByRole('button', { name: 'Copiar código ORC-K7M42P' }));
    expect(await navigator.clipboard.readText()).toBe('ORC-K7M42P');
    expect(within(row as HTMLElement).getByRole('status').textContent).toBe('Copiado');
  });
  it('pedido novo recebe um código válido que não muda ao editar nem ao mudar o status', async () => {
    await seed([]); const u = user(); render(<App />); await loaded(); await nav(u, 'Nova encomenda');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Cliente Novo');
    await u.selectOptions(screen.getByLabelText('Receita'), 'bolo');
    fireEvent.change(screen.getByLabelText('Data de entrega'), { target: { value: '2026-12-10' } });
    fireEvent.change(screen.getByLabelText('Preço de venda unitário (R$)'), { target: { value: '20' } });
    await u.click(screen.getByRole('button', { name: /Registrar encomenda/ })); await screen.findByText('Encomenda cadastrada.');
    const [code] = cards(); expect(code).toMatch(/^ORC-[A-Z2-9]{6}$/);
    await u.click(screen.getByRole('button', { name: /Editar/ }));
    fireEvent.change(screen.getByLabelText('Preço de venda unitário (R$)'), { target: { value: '25' } }); await u.click(screen.getByRole('button', { name: /Salvar alterações/ })); await screen.findByText(/Encomenda atualizada/);
    await u.selectOptions(screen.getByLabelText('Status'), 'Entregue');
    expect(cards()).toEqual([code]);
    await waitFor(async () => expect((await loadData()).orders[0].quoteCode).toBe(code)); // e está gravado
  });
  it('pedido antigo (sem código) mostra o código derivado, estável entre recarregamentos, sem alterar valores', async () => {
    await seed([order('legado-1', 'Cliente Antigo', 'Confirmado', 'bolo', { deposit: 4, payments: [{ id: 'p', amount: 3, receivedAt: '2026-11-12' }] })]);
    const u = user(); const first = render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(cards()).toEqual([legacyQuoteCode('legado-1')]); await u.click(screen.getByRole('button', { name: 'Ver detalhes' })); expect(screen.getByText('Total recebido').parentElement?.textContent).toMatch(/7,00/); // sinal 4 + recebimento 3: intactos
    first.unmount(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(cards()).toEqual([legacyQuoteCode('legado-1')]);
  });
  it('o texto copiado do orçamento inclui o código', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    const row = screen.getByText('ORC-K7M42P').closest('li')!;
    await u.click(within(row).getByRole('button', { name: 'Ver detalhes' }));
    await u.click(screen.getByRole('button', { name: /Copiar orçamento/ }));
    expect(await navigator.clipboard.readText()).toContain('orçamento ORC-K7M42P');
  });
});

describe('Pesquisa expansível', () => {
  it('recolhida parece um botão (não um campo); ao clicar expande, foca o campo e mostra o placeholder', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(screen.queryByRole('searchbox')).toBeNull(); expect(screen.queryByPlaceholderText(/Código, cliente ou produto/)).toBeNull();
    await u.click(search());
    const input = await screen.findByRole('searchbox', { name: 'Pesquisar pedidos' });
    expect(input.getAttribute('placeholder')).toBe('Código, cliente ou produto...'); expect(document.activeElement).toBe(input);
    expect(cards()).toHaveLength(3);
  });
  it('filtra enquanto digita (sem Enter), por cliente, produto, status e sem acento/caixa; mostra a contagem', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); const input = screen.getByRole('searchbox');
    await u.type(input, 'JOSE'); expect(cards()).toEqual(['ORC-X9T3QW']); expect(screen.getByText('1 de 3 pedidos')).toBeTruthy();
    await u.clear(input); await u.type(input, 'cenoura'); expect(cards().sort()).toEqual(['ORC-K7M42P', 'ORC-K7N8RB']);
    await u.clear(input); await u.type(input, 'entregue'); expect(cards()).toEqual(['ORC-K7N8RB']);
    await u.clear(input); await u.type(input, 'antonia'); expect(cards()).toEqual(['ORC-K7N8RB']);
  });
  it('encontra pelo código com ou sem prefixo e hífen, e nunca por identificador interno', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); const input = screen.getByRole('searchbox');
    for (const q of ['ORC-K7M42P', 'orck7m42p', 'k7m42p', 'k7m4']) { await u.clear(input); await u.type(input, q); expect(cards(), q).toEqual(['ORC-K7M42P']); }
    await u.clear(input); await u.type(input, 'o1'); expect(screen.getByText(/Nenhum pedido encontrado/)).toBeTruthy(); // "o1" é o id interno
  });
  it('sem resultados mostra estado vazio amigável com saída para a lista completa', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); await u.type(screen.getByRole('searchbox'), 'zzzz');
    const empty = screen.getByText('Nenhum pedido encontrado.'); expect(empty).toBeTruthy();
    await u.click(within(empty.closest('.orders-empty') as HTMLElement).getByRole('button', { name: 'Limpar pesquisa' })); expect(cards()).toHaveLength(3);
  });
  it('limpar mantém o campo aberto; fechar volta à lista completa e devolve o foco ao botão', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); const input = screen.getByRole('searchbox'); await u.type(input, 'ana');
    expect(cards()).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Limpar pesquisa' }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(''); expect(cards()).toHaveLength(3); expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    await u.type(screen.getByRole('searchbox'), 'ana');
    await u.click(screen.getByRole('button', { name: /Fechar pesquisa/ }));
    expect(screen.queryByRole('searchbox')).toBeNull(); expect(cards()).toHaveLength(3); await waitFor(() => expect(document.activeElement).toBe(search()));
  });
  it('Esc: primeiro limpa o texto, depois fecha (previsível); o campo continua aberto enquanto houver texto', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); await u.type(screen.getByRole('searchbox'), 'maria');
    await u.keyboard('{Escape}'); expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(''); expect(cards()).toHaveLength(3);
    await u.keyboard('{Escape}'); expect(screen.queryByRole('searchbox')).toBeNull(); expect(search()).toBeTruthy();
  });
  it('a busca olha todos os pedidos, não só os visíveis (vários pedidos)', async () => {
    const many = Array.from({ length: 60 }, (_, n) => order(`m${n}`, `Cliente ${n}`, 'Orçamento', 'bolo', { quoteCode: n === 7 ? 'ORC-ALVO22' : `ORC-ZZ${String(n).padStart(4, '2')}`.replace(/[01ILOU]/g, '3') }));
    await seed(many); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(search()); await u.type(screen.getByRole('searchbox'), 'alvo22');
    expect(cards()).toEqual(['ORC-ALVO22']); expect(screen.getByText('1 de 60 pedidos')).toBeTruthy();
  });
  it('acessível: o botão e os controles têm nomes; campo do tipo busca com dica de teclado', async () => {
    await three(); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(search().getAttribute('aria-expanded')).toBe('false');
    await u.click(search());
    const box = screen.getByRole('search'); expect(within(box).getByRole('searchbox').getAttribute('enterkeyhint')).toBe('search');
    expect(within(box).getByRole('button', { name: 'Fechar pesquisa e mostrar todos os pedidos' })).toBeTruthy();
    await u.tab(); expect(document.activeElement).toBe(within(box).getByRole('button', { name: /Fechar pesquisa/ })); // Tab: próximo controle (sem texto não há botão Limpar)
  });
});
