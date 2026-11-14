// @vitest-environment jsdom
/** Etapa 11 — interface: vários produtos na encomenda, resumo em tempo real, confirmação automática, lista e detalhes. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App';
import { emptyData, loadData, saveData } from '../../src/storage/db';
import type { DataSet } from '../../src/domain/types';
import { orderTotal } from '../../src/domain/payments';
import { resetStorage } from './setup';

const user = () => userEvent.setup();
const nav = async (u: ReturnType<typeof user>, name: string) => u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name }));
const loaded = async () => waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
const recipe = (id: string, name: string) => ({ id, name, yield: 1, items: [{ ingredientId: 'base', quantity: 1, unit: 'un' as const }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 50 });
const seed = async (orders: unknown[] = []) => saveData({ ...emptyData(),
  ingredients: [{ id: 'base', name: 'Base', unit: 'un', purchaseQuantity: 100, purchasePrice: 50 }],
  packagings: [{ id: 'caixa', name: 'Caixa para doces', purchasePrice: 12, purchaseQuantity: 1, capacity: 50, active: true }],
  recipes: [recipe('brig', 'Brigadeiro Gourmet'), recipe('beij', 'Beijinho'), recipe('bolo', 'Bolo de cenoura')],
  orders: orders as DataSet['orders'],
});
const product = (n: number) => screen.getByRole('listitem', { name: `Produto ${n}` });
const fill = async (u: ReturnType<typeof user>, n: number, recipeName: string, qty: string, price: string) => {
  const row = product(n);
  await u.selectOptions(within(row).getByLabelText('Receita'), recipeName);
  fireEvent.change(within(row).getByLabelText('Quantidade'), { target: { value: qty } });
  fireEvent.change(within(row).getByLabelText('Preço de venda unitário (R$)'), { target: { value: price } });
};
const summary = (label: RegExp | string) => screen.getByText(label).parentElement!.textContent!;

beforeEach(async () => { await resetStorage(); window.history.replaceState({}, '', '/'); });

describe('Nova encomenda com várias receitas', () => {
  it('adiciona, edita e remove produtos sem perder o que já foi preenchido; o resumo soma em tempo real (exemplo R$ 277,00)', async () => {
    await seed(); const u = user(); render(<App />); await loaded(); await nav(u, 'Nova encomenda');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Ana Martins');
    fireEvent.change(screen.getByLabelText('Data de entrega'), { target: { value: '2026-12-20' } });
    await fill(u, 1, 'Brigadeiro Gourmet', '50', '2,50');
    await u.click(screen.getByRole('button', { name: /Adicionar receita/ }));
    await fill(u, 2, 'Beijinho', '30', '2,50');
    await u.click(screen.getByRole('button', { name: /Adicionar receita/ }));
    await fill(u, 3, 'Bolo de cenoura', '1', '65');
    // A receita já escolhida não aparece de novo em outra linha (sem duplicidade acidental).
    expect(within(within(product(3)).getByLabelText('Receita')).queryByRole('option', { name: 'Brigadeiro Gourmet' })).toBeNull();
    expect(within(product(1)).getByText('R$ 125,00')).toBeTruthy();
    expect(within(product(2)).getByText('R$ 75,00')).toBeTruthy();
    expect(summary(/^Produtos \(3 itens\)/)).toMatch(/265,00/);
    await u.click(screen.getByRole('button', { name: /Adicionar embalagem adicional/ }));
    fireEvent.change(within(document.querySelector('.order-package-line') as HTMLElement).getByLabelText('Quantidade'), { target: { value: '1' } });
    expect(screen.getByText(/Com vários produtos, informe manualmente/)).toBeTruthy();
    expect(summary('Total cobrado')).toMatch(/277,00/);
    // Remover o 2º produto mantém os dados das outras linhas.
    await u.click(screen.getByRole('button', { name: 'Remover produto 2' }));
    expect((within(product(1)).getByLabelText('Quantidade') as HTMLInputElement).value).toBe('50');
    expect((within(product(2)).getByLabelText('Receita') as HTMLSelectElement).value).toBe('bolo');
    expect(summary('Total cobrado')).toMatch(/202,00/);
    await u.click(screen.getByRole('button', { name: /Adicionar receita/ }));
    await fill(u, 3, 'Beijinho', '30', '2,50');
    expect(screen.queryByText(/será confirmada automaticamente/)).toBeNull();
    await u.click(screen.getByRole('button', { name: /Registrar encomenda/ }));
    expect(await screen.findByText('Encomenda cadastrada.')).toBeTruthy();
    const saved = (await loadData()).orders[0];
    expect(saved.status).toBe('Orçamento');
    expect(saved.items.map(i => [i.recipeName, i.quantity, i.unitPrice])).toEqual([['Brigadeiro Gourmet', 50, 2.5], ['Bolo de cenoura', 1, 65], ['Beijinho', 30, 2.5]]);
    expect(orderTotal(saved)).toBe(277);
  });

  it('o sinal é opcional; informado, avisa e cria a encomenda já Confirmada', async () => {
    await seed(); const u = user(); render(<App />); await loaded(); await nav(u, 'Nova encomenda');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Bia');
    fireEvent.change(screen.getByLabelText('Data de entrega'), { target: { value: '2026-12-20' } });
    await fill(u, 1, 'Bolo de cenoura', '1', '65');
    fireEvent.change(screen.getByLabelText('Sinal recebido (opcional)'), { target: { value: '20' } });
    expect(screen.getByText('Ao registrar este sinal, a encomenda será confirmada automaticamente.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /Registrar encomenda/ }));
    expect(await screen.findByText('Encomenda cadastrada e confirmada pelo sinal recebido.')).toBeTruthy();
    expect((await loadData()).orders[0]).toMatchObject({ status: 'Confirmado', deposit: 20 });
  });

  it('não salva sem produto válido (receita não escolhida)', async () => {
    await seed(); const u = user(); render(<App />); await loaded(); await nav(u, 'Nova encomenda');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Bia');
    fireEvent.change(screen.getByLabelText('Data de entrega'), { target: { value: '2026-12-20' } });
    fireEvent.submit(screen.getByRole('button', { name: /Registrar encomenda/ }).closest('form')!);
    expect(await screen.findByText(/Receita do produto 1 não encontrada/)).toBeTruthy();
    expect((await loadData()).orders).toEqual([]);
  });
});

describe('Lista, detalhes e recebimento', () => {
  const multi = { id: 'o1', customer: 'Ana', deposit: 0, deliveryDate: '2026-12-20', status: 'Orçamento', createdAt: '2026-11-14T10:00:00.000Z', quoteCode: 'ORC-K7M42P', packagingCharge: 12,
    packagingItems: [{ packagingId: 'caixa', name: 'Caixa para doces', quantity: 1, unitCost: 12 }],
    items: [{ id: 'a', recipeId: 'brig', recipeName: 'Brigadeiro Gourmet', quantity: 50, unitPrice: 2.5 }, { id: 'b', recipeId: 'beij', recipeName: 'Beijinho', quantity: 30, unitPrice: 2.5 }, { id: 'c', recipeId: 'bolo', recipeName: 'Bolo de cenoura', quantity: 1, unitPrice: 65 }] };
  it('a lista resume os itens e mostra o total consolidado', async () => {
    await seed([multi]); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(screen.getByText('3 itens — Brigadeiro Gourmet, Beijinho e Bolo de cenoura')).toBeTruthy();
    expect(screen.getAllByText('R$ 277,00').length).toBeGreaterThan(0); // total (e saldo, sem recebimentos)
  });
  it('detalhes mostram cada item; o primeiro recebimento confirma o orçamento; o texto copiado não discrimina embalagens', async () => {
    await seed([multi]); const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    const table = screen.getByRole('table');
    for (const text of ['Brigadeiro Gourmet', 'Beijinho', 'Bolo de cenoura', 'R$ 125,00', 'R$ 75,00', 'R$ 65,00']) expect(within(table).getAllByText(text).length).toBeGreaterThan(0);
    await u.click(screen.getByRole('button', { name: /Copiar orçamento/ }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('• 50 × Brigadeiro Gourmet'); expect(copied).toMatch(/Total: R\$\s*277,00/);
    for (const s of ['Caixa', '12,00', '2,50']) expect(copied).not.toContain(s);
    await u.click(screen.getByRole('button', { name: /Registrar recebimento/ }));
    expect(screen.getByText('Ao registrar este recebimento, a encomenda será confirmada automaticamente.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Valor recebido (R$)'), { target: { value: '100' } });
    await u.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    expect(await screen.findByText('Recebimento registrado. A encomenda foi confirmada automaticamente.')).toBeTruthy();
    await waitFor(async () => expect((await loadData()).orders[0].status).toBe('Confirmado'));
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('Confirmado');
  });
  it('editar a encomenda mostra os itens existentes e preserva o histórico', async () => {
    await seed([{ ...multi, items: multi.items.map(i => ({ ...i, costSnapshot: { costPerUnit: 0.42, capturedAt: '2026-11-01T10:00:00.000Z' } })) }]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    await u.click(screen.getByRole('button', { name: 'Ver detalhes' })); await u.click(screen.getByRole('button', { name: /Editar/ }));
    expect(screen.getAllByRole('listitem', { name: /Produto \d/ })).toHaveLength(3);
    expect(screen.getAllByText(/Custo registrado em 01\/11\/2026 mantido/)).toHaveLength(3);
    fireEvent.change(within(product(1)).getByLabelText('Quantidade'), { target: { value: '60' } });
    await u.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(async () => expect((await loadData()).orders[0].items[0]).toMatchObject({ id: 'a', quantity: 60, costSnapshot: { costPerUnit: 0.42 } }));
  });
});
