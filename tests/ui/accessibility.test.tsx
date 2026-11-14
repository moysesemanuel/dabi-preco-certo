// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App';
import { resetStorage } from './setup';

beforeEach(async () => { await resetStorage(); window.history.replaceState({}, '', '/'); });
const loaded = async () => { await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull()); };

describe('Acessibilidade básica', () => {
  it('tem link para pular ao conteúdo, navegação nomeada e página atual indicada', async () => {
    render(<App />); await loaded();
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe('#conteudo');
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    expect(within(nav).getByRole('button', { name: 'Visão geral' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Agenda' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('main')).toBeTruthy();
  });
  it('ao trocar de página o foco vai para o título (leitores de tela)', async () => {
    const u = userEvent.setup();
    render(<App />); await loaded();
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Agenda' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Agenda', level: 1 }));
    expect(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Agenda' }).getAttribute('aria-current')).toBe('page');
  });
  it('os campos principais dos formulários têm rótulo e os botões de ícone têm nome', async () => {
    const u = userEvent.setup();
    render(<App />); await loaded();
    const go = (name: string) => u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name }));
    await go('Ingredientes');
    for (const label of ['Nome do ingrediente', 'Quantidade comprada', 'Unidade', 'Preço pago (R$)']) expect(screen.getByLabelText(label), label).toBeTruthy();
    await go('Receitas e preços');
    for (const label of ['Nome da receita', 'Rendimento (unidades)', 'Margem desejada (%)', 'Tempo de produção, em minutos (opcional)']) expect(screen.getByLabelText(label), label).toBeTruthy();
    await go('Nova encomenda');
    for (const label of ['Nome do cliente', 'Receita', 'Quantidade', 'Preço de venda unitário (R$)', 'Data de entrega', 'Sinal recebido (opcional)']) expect(screen.getByLabelText(label), label).toBeTruthy();
    await go('Configurações');
    for (const label of ['Nome do negócio (aparece nos orçamentos)', 'Telefone/WhatsApp do negócio (aparece nos orçamentos)', 'Capacidade de produção por dia (minutos)']) expect(screen.getByLabelText(label), label).toBeTruthy();
  });
  it('mensagens de retorno são anunciadas (role=status) e nenhum botão fica sem nome', async () => {
    const u = userEvent.setup();
    render(<App />); await loaded();
    await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name: 'Ingredientes' }));
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Sal');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '2' } });
    await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
    expect((await screen.findByText('Ingrediente cadastrado.')).closest('[role="status"]')).toBeTruthy();
    for (const b of screen.getAllByRole('button')) expect((b.textContent ?? '').trim() || b.getAttribute('aria-label') || b.getAttribute('title'), b.outerHTML).toBeTruthy();
  });
});
