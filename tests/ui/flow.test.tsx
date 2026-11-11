// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { localToday } from '../../src/utils';
import { resetStorage } from './setup';

const user = () => userEvent.setup();
const nav = async (u: ReturnType<typeof user>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const loaded = async () => { await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull()); };
const toast = () => screen.queryByRole('status', { name: '' });

beforeEach(async () => { await resetStorage(); vi.stubGlobal('confirm', () => true); });

async function createIngredientAndRecipe(u: ReturnType<typeof user>) {
  await nav(u, 'Ingredientes');
  await u.type(screen.getByLabelText('Nome do ingrediente'), 'Farinha de trigo');
  await u.type(screen.getByLabelText('Preço pago (R$)'), '6');
  await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
  expect(await screen.findByText('Ingrediente cadastrado.')).toBeTruthy();

  await nav(u, 'Receitas e preços');
  await u.type(screen.getByLabelText('Nome da receita'), 'Bolo de cenoura');
  await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
  fireEvent.change(screen.getByLabelText('Quantidade utilizada'), { target: { value: '500' } });
  await u.click(screen.getByRole('button', { name: /Salvar receita/ }));
  expect(await screen.findByText('Receita cadastrada.')).toBeTruthy();
}

describe('Fluxo crítico: ingrediente → receita → preço → encomenda → recebimento → agenda', () => {
  it('percorre o fluxo completo e preserva o custo histórico e os recebimentos', async () => {
    const u = user();
    render(<App />); await loaded();
    await createIngredientAndRecipe(u);

    // O simulador mostra o custo e o preço sugerido (500 g a R$ 6/kg = R$ 3,00; 10 unidades; margem 30%).
    const sim = screen.getByText('Simulador de preço').closest('div')!.parentElement!;
    expect(within(sim).getByText('Custo por unidade')).toBeTruthy();
    expect(within(sim).getAllByText('R$ 0,30').length).toBeGreaterThan(0);

    // Encomenda
    await nav(u, 'Encomendas');
    await u.type(screen.getByLabelText('Nome do cliente'), 'Ana Martins');
    await u.selectOptions(screen.getByLabelText('Receita'), 'Bolo de cenoura');
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Preço unitário (R$)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Data da entrega'), { target: { value: localToday() } });
    fireEvent.change(screen.getByLabelText('Sinal recebido (R$)'), { target: { value: '10' } });
    await u.click(screen.getByRole('button', { name: /Registrar encomenda/ }));
    expect(await screen.findByText('Encomenda cadastrada.')).toBeTruthy();
    expect(screen.getByText(/Custo registrado no pedido: R\$ 0,30 por unidade/)).toBeTruthy();
    expect(screen.getByText(/Valor: R\$ 40,00/)).toBeTruthy();
    expect(screen.getByText('R$ 30,00', { selector: 'strong' })).toBeTruthy(); // saldo pendente: 40 − 10

    // O custo registrado NÃO muda quando o ingrediente fica mais caro
    await nav(u, 'Ingredientes');
    await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '60' } });
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    await nav(u, 'Encomendas');
    expect(screen.getByText(/Custo registrado no pedido: R\$ 0,30 por unidade/)).toBeTruthy();

    // Recebimento parcial e limite do saldo
    await u.click(screen.getByRole('button', { name: /Registrar recebimento/ }));
    const amount = screen.getByLabelText('Valor recebido (R$)');
    fireEvent.change(amount, { target: { value: '35' } });
    await u.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    expect(await screen.findByText('O valor é maior que o saldo pendente.')).toBeTruthy(); // 35 > 30
    fireEvent.change(amount, { target: { value: '20' } });
    await u.click(screen.getByRole('button', { name: 'Registrar recebimento' }));
    expect(await screen.findByText('Recebimento registrado.')).toBeTruthy();
    expect(screen.getByText('R$ 10,00', { selector: 'strong' })).toBeTruthy(); // saldo: 40 − 10 − 20

    // Agenda: um pedido novo está em "Orçamento", e a tela explica por que ele ainda não aparece
    await nav(u, 'Agenda');
    expect(screen.getByText(/1 encomenda\(s\) em/)).toBeTruthy();
    expect(screen.queryByText('Ana Martins')).toBeNull();
    await u.click(screen.getByLabelText('Incluir orçamentos'));
    expect(screen.getByText('Ana Martins')).toBeTruthy();
    await u.click(screen.getByLabelText('Incluir orçamentos'));
    // confirmado o pedido, a entrega de hoje aparece
    await nav(u, 'Encomendas');
    await u.selectOptions(screen.getByLabelText('Status'), 'Confirmado');
    await nav(u, 'Agenda');
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy();
    const today = screen.getByText(/^Hoje ·/).closest('section')!;
    expect(within(today).getByText('Ana Martins')).toBeTruthy();
    expect(within(today).getByText(/A receber R\$ 10,00/)).toBeTruthy();
  });

  it('os dados continuam lá depois de recarregar a página (IndexedDB real)', async () => {
    const u = user();
    const first = render(<App />); await loaded();
    await createIngredientAndRecipe(u);
    await waitFor(async () => { const r = indexedDB.open('pedidocerto-v1', 1); await new Promise(res => { r.onsuccess = res; }); }); // dá tempo da fila de gravação
    await new Promise(r => setTimeout(r, 100));
    first.unmount();
    render(<App />); await loaded();
    await nav(u, 'Receitas e preços');
    expect(await screen.findByText('Bolo de cenoura', { selector: 'strong' })).toBeTruthy();
    await nav(u, 'Ingredientes');
    expect(screen.getByText('Farinha de trigo')).toBeTruthy();
  });

  it('um formulário inválido mostra uma mensagem clara e não grava nada', async () => {
    const u = user();
    render(<App />); await loaded();
    await nav(u, 'Ingredientes');
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Açúcar');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '-3' } });
    fireEvent.submit(screen.getByLabelText('Nome do ingrediente').closest('form')!);
    expect(await screen.findByText('Preencha nome, quantidade positiva e preço válido.')).toBeTruthy();
    expect(screen.getByText('Sua lista de ingredientes aparecerá aqui.')).toBeTruthy();
  });
});

describe('Estados de carregamento e vazios', () => {
  it('mostra "Carregando" e não oferece formulários até os dados serem lidos', async () => {
    render(<App />);
    expect(screen.getByText('Carregando seus dados…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nova encomenda/ })).toBeNull();
    await loaded();
    expect(screen.getByRole('heading', { name: /Bom trabalho começa organizado/ })).toBeTruthy();
  });
  it('páginas vazias explicam o próximo passo', async () => {
    const u = user();
    render(<App />); await loaded();
    await nav(u, 'Encomendas'); expect(screen.getByText('Nenhum pedido cadastrado.')).toBeTruthy();
    await nav(u, 'Agenda'); expect(screen.getByText('Nenhuma entrega para hoje.')).toBeTruthy();
    await nav(u, 'Receitas e preços'); expect(screen.getByText('Ainda não há receitas.')).toBeTruthy();
  });
});
