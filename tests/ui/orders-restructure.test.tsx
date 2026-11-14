// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App';
import { emptyData, loadData, saveData } from '../../src/storage/db';
import type { DataSet } from '../../src/domain/types';
import { balanceDue, orderTotal } from '../../src/domain/payments';
import { resetStorage } from './setup';

const user = () => userEvent.setup();
const nav = async (u: ReturnType<typeof user>, name: string) => u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name }));
const loaded = async () => waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
const seed = async (orders: DataSet['orders'] = []) => {
  const base = emptyData();
  await saveData({ ...base,
    ingredients: [{ id: 'choc', name: 'Chocolate', unit: 'g', purchaseQuantity: 1000, purchasePrice: 20 }],
    packagings: [
      { id: 'forminha', name: 'Forminha', purchasePrice: 10, purchaseQuantity: 100, active: true },
      { id: 'caixa', name: 'Caixa para 25', purchasePrice: 3.75, purchaseQuantity: 1, capacity: 25, active: true },
    ],
    recipes: [{ id: 'brig', name: 'Brigadeiro Gourmet', yield: 25, items: [{ ingredientId: 'choc', quantity: 25, unit: 'g' }], packagingItems: [{ packagingId: 'forminha', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
    orders,
  });
};

beforeEach(async () => { await resetStorage(); window.history.replaceState({}, '', '/'); });

describe('Etapa 10 — navegação e pedido', () => {
  it('separa Nova encomenda de Pedidos e abre detalhes com URL recarregável', async () => {
    await seed([{ id: 'o1', customer: 'Ana', recipeId: 'brig', quantity: 25, unitPrice: 2.5, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-13T10:00:00.000Z' }]);
    const u = user(); render(<App />); await loaded();
    await nav(u, 'Nova encomenda');
    expect(window.location.pathname).toBe('/encomendas/nova');
    expect(screen.getByRole('heading', { name: 'Nova encomenda' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Pedidos' })).toBeNull();
    await nav(u, 'Pedidos');
    expect(window.location.pathname).toBe('/pedidos');
    expect(screen.getByText('Acompanhe suas encomendas, pagamentos e entregas.')).toBeTruthy();
    expect(screen.queryByLabelText('Nome do cliente')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(window.location.pathname).toMatch(/^\/pedidos\//);
    expect(screen.getByRole('heading', { name: 'Ana' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Composição financeira' })).toBeTruthy();
  });

  it('calcula produtos + embalagem adicional e saldo em tempo real; o sinal pode ficar vazio', async () => {
    await seed(); const u = user(); render(<App />); await loaded(); await nav(u, 'Nova encomenda');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Brigadeiros da Ana');
    await u.selectOptions(screen.getByLabelText('Receita'), 'brig');
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Preço de venda unitário (R$)'), { target: { value: '2,50' } });
    fireEvent.change(screen.getByLabelText('Data de entrega'), { target: { value: '2026-12-10' } });
    expect(screen.getAllByText('R$ 62,50').length).toBeGreaterThan(0);
    await u.click(screen.getByRole('button', { name: /Adicionar embalagem adicional/ }));
    await u.selectOptions(screen.getByLabelText('Embalagem adicional'), 'caixa');
    expect(screen.getAllByText('R$ 66,25').length).toBeGreaterThan(0);
    expect(screen.getByText('Saldo restante').parentElement?.textContent).toMatch(/66,25/);
    fireEvent.change(screen.getByLabelText('Sinal recebido (opcional)'), { target: { value: '20' } });
    expect(screen.getByText('Saldo restante').parentElement?.textContent).toMatch(/46,25/);
    expect((screen.getByLabelText('Sinal recebido (opcional)') as HTMLInputElement).value).toBe('20,00');
    expect(screen.getByText('Ao registrar este sinal, a encomenda será confirmada automaticamente.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /Registrar encomenda/ }));
    await screen.findByText('Encomenda cadastrada e confirmada pelo sinal recebido.');
    expect(screen.getByRole('heading', { name: 'Brigadeiros da Ana' })).toBeTruthy();
    const saved = (await loadData()).orders[0];
    expect(saved).toMatchObject({ items: [{ quantity: 25, unitPrice: 2.5 }], deposit: 20, packagingCharge: 3.75, status: 'Confirmado' });
    expect(orderTotal(saved)).toBe(66.25);
    expect(balanceDue(saved)).toBe(46.25);
    expect((await loadData()).orders[0].items[0].costSnapshot?.packagingItems).toEqual([{ packagingId: 'forminha', name: 'Forminha', quantityPerUnit: 1, unitCost: 0.1 }]);
  });

  it('mantém encomenda legada sem cobrança retroativa e preserva recebimentos ao editar outros dados', async () => {
    await seed([{ id: 'old', customer: 'Cliente antiga', recipeId: 'brig', quantity: 25, unitPrice: 2.5, deposit: 10, payments: [{ id: 'pay-old', amount: 5, receivedAt: '2026-11-12', method: 'Pix' }], deliveryDate: '2026-12-01', status: 'Entregue', createdAt: '2026-11-10T10:00:00.000Z', packagingItems: [{ packagingId: 'caixa', name: 'Caixa para 25', quantity: 1, unitCost: 3.75 }] }]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Pedidos');
    expect(screen.getAllByText('R$ 62,50').length).toBeGreaterThan(0);
    await u.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(screen.getAllByText(/0,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/anterior à cobrança automática/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Nome do cliente'), { target: { value: 'Cliente atualizada' } });
    await u.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    const saved = (await loadData()).orders[0];
    expect(saved).toMatchObject({ customer: 'Cliente atualizada', items: [{ quantity: 25, unitPrice: 2.5 }], deposit: 10 });
    expect(saved.packagingCharge ?? 0).toBe(0);
    expect(saved.payments).toEqual([{ id: 'pay-old', amount: 5, receivedAt: '2026-11-12', method: 'Pix' }]);
    expect(orderTotal(saved)).toBe(62.5);
  });
});
