// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { saveData } from '../../src/storage/db';
import { resetStorage } from './setup';

const user = () => userEvent.setup();
const nav = async (u: ReturnType<typeof user>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };
const loaded = async () => { await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull()); };
const fetchSpy = vi.fn(async () => { throw new TypeError('sem rede'); });

beforeEach(async () => { await resetStorage(); fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy); vi.stubGlobal('confirm', () => true); });

const typeName = async (u: ReturnType<typeof user>, text: string) => { await u.clear(screen.getByLabelText('Nome do ingrediente')); await u.type(screen.getByLabelText('Nome do ingrediente'), text); };
const save = async (u: ReturnType<typeof user>, price = '6') => { fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: price } }); await u.click(screen.getByRole('button', { name: /Adicionar ingrediente|Salvar alterações/ })); };
const row = (name: string) => screen.getByText(name, { selector: 'td' }).closest('tr')!;

describe('Cadastro de ingrediente com medidas de referência', () => {
  it('o formulário principal tem só nome, quantidade, unidade e preço; as medidas ficam numa área secundária e opcional', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    const form = screen.getByLabelText('Nome do ingrediente').closest('form')!;
    expect(within(form).getByLabelText('Quantidade comprada')).toBeTruthy(); expect(within(form).getByLabelText('Preço pago (R$)')).toBeTruthy();
    const details = within(form).getByText(/Medidas e equivalências/).closest('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(screen.queryByText(/densidade/i)).toBeNull(); // sem jargão técnico
    await typeName(u, 'Ingrediente totalmente desconhecido'); await save(u); // salva sem preencher nenhuma equivalência
    expect(await screen.findByText('Ingrediente cadastrado.')).toBeTruthy();
    expect(within(row('Ingrediente totalmente desconhecido')).queryByText(/xícara/)).toBeNull();
  });

  it('encontra o ingrediente (sem acento, maiúsculas), oferece a referência e mostra fonte e aviso de valor aproximado', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'FARINHA de Trigo');
    const notice = await screen.findByText(/Encontramos medidas de referência para/);
    expect(notice.textContent).toContain('Farinha de trigo');
    await u.click(screen.getByRole('button', { name: 'Usar medidas de referência' }));
    const form = screen.getByLabelText('Nome do ingrediente').closest('form')!;
    expect(within(form).getByText('valor aproximado')).toBeTruthy();
    await u.click(within(form).getByText('Ver fonte'));
    expect(form.textContent).toMatch(/USDA FoodData Central/); expect(form.textContent).toMatch(/CC0/);
    expect(form.textContent).toMatch(/1 xícara ≈ 126,8 g \(referência\)/);
    await save(u);
    await screen.findByText('Ingrediente cadastrado.');
    expect(row('FARINHA de Trigo').textContent).toMatch(/1 xícara ≈ 126,8 g \(referência\)/);
  });

  it('o usuário personaliza o peso (prioridade sobre a referência) e pode restaurar a referência', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar'); await u.click(await screen.findByRole('button', { name: 'Usar medidas de referência' }));
    fireEvent.change(screen.getByLabelText('Quanto pesa uma xícara (em gramas)?'), { target: { value: '180' } });
    expect(screen.getByText('O valor que você informou vale mais do que a referência.')).toBeTruthy();
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    expect(row('Açúcar').textContent).toMatch(/1 xícara ≈ 180 g \(informado por você\)/);
    await u.click(screen.getByRole('button', { name: 'Editar Açúcar' }));
    expect((screen.getByLabelText('Quanto pesa uma xícara (em gramas)?') as HTMLInputElement).value).toBe('180'); // só o valor do usuário; a referência não é "copiada" para o campo
    await u.click(screen.getByRole('button', { name: 'Restaurar referência' }));
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    await screen.findByText(/Ingrediente atualizado/);
    expect(row('Açúcar').textContent).toMatch(/\(referência\)/); expect(row('Açúcar').textContent).not.toMatch(/informado por você/);
  });

  it('nome ambíguo só sugere opções (nunca escolhe) e ingrediente desconhecido avisa sem bloquear', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'farinha');
    const group = await screen.findByRole('group', { name: 'Medidas de referência parecidas' });
    expect(within(group).getByRole('button', { name: 'Farinha de trigo' })).toBeTruthy(); expect(within(group).getByRole('button', { name: 'Farinha de arroz' })).toBeTruthy();
    expect(screen.queryByText(/Encontramos medidas de referência para/)).toBeNull();
    await typeName(u, 'Ingrediente raro xyz');
    await u.click(screen.getByText(/Medidas e equivalências/));
    expect(screen.getByText(/Não encontramos uma referência para este ingrediente/)).toBeTruthy();
    await save(u); expect(await screen.findByText('Ingrediente cadastrado.')).toBeTruthy();
  });

  it('apresentações diferentes: o usuário escolhe a correta (ex.: açúcar de confeiteiro peneirado ou não)', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar de confeiteiro');
    const select = await screen.findByRole('combobox', { name: 'Apresentação' }) as HTMLSelectElement;
    expect([...select.options].map(o => o.text)).toEqual(['Sem peneirar', 'Peneirado']);
    await u.selectOptions(select, 'peneirado');
    await u.click(screen.getByRole('button', { name: 'Usar medidas de referência' }));
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    expect(row('Açúcar de confeiteiro').textContent).toMatch(/1 xícara ≈ 101,4 g/); // 100 g por xícara americana → 240 mL
  });

  it('mudar as medidas avisa quais receitas mudaram de custo (sem tocar encomendas) e não altera valores por conta própria', async () => {
    await saveData({ schemaVersion: 3, settings: { cupSizeMl: 240 }, ingredients: [{ id: 'f', name: 'Farinha de trigo', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, densityGPerMl: 0.5 }],
      recipes: [{ id: 'r', name: 'Bolo de teste', yield: 10, items: [{ ingredientId: 'f', quantity: 2, unit: 'xic' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
      orders: [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', costSnapshot: { costPerUnit: 0.24, capturedAt: '2026-11-11T10:00:00.000Z' } }] });
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    expect(row('Farinha de trigo').textContent).toMatch(/1 xícara ≈ 120 g \(informado por você\)/); // nada mudou sozinho: continua o valor antigo
    await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
    await u.click(screen.getByRole('button', { name: 'Usar medidas de referência' }));
    fireEvent.change(screen.getByLabelText('Quanto pesa uma xícara (em gramas)?'), { target: { value: '' } }); // remove o valor informado: passa a valer a referência
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    const msg = await screen.findByText(/as medidas mudaram o cálculo/);
    expect(msg.textContent).toMatch(/1 receita mudou de custo por unidade: Bolo de teste \(R\$\s0,14 → R\$\s0,15\)/);
    expect(msg.textContent).toMatch(/Encomendas e custos já registrados não mudaram/);
  });
});

describe('Conversor reformulado (sem rede)', () => {
  const pick = async (u: ReturnType<typeof user>, text: string, option: RegExp | string = text) => {
    await u.type(screen.getByRole('combobox', { name: /Ingrediente/ }), text);
    await u.click(await screen.findByRole('option', { name: option }));
  };
  const result = () => screen.getByText('RESULTADO').parentElement!;

  it('farinha de trigo: 2 xícaras de 240 mL → gramas, com origem da referência e sem consultar a rede', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'farinha de trigo', /^Farinha de trigo Catálogo$/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '2' } });
    expect(result().textContent).toMatch(/≈ 253,6 g/); expect(result().textContent).toMatch(/Aproximado · referência do catálogo/);
    expect(result().textContent).toMatch(/1 xícara de Farinha de trigo ≈ 126,8 g \(xícara de 240 mL\)/);
    expect(fetchSpy).not.toHaveBeenCalled(); // catálogo local: nenhuma consulta externa
  });
  it('aceita frações, decimais com vírgula e a conversão inversa', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'farinha de trigo', /^Farinha de trigo Catálogo$/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '1/2' } }); expect(result().textContent).toMatch(/≈ 63,4 g/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '1 1/2' } }); expect(result().textContent).toMatch(/≈ 190,2 g/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '0,5' } }); expect(result().textContent).toMatch(/≈ 63,4 g/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '253,6' } });
    await u.click(screen.getByRole('button', { name: 'Inverter conversão' })); // agora de gramas para xícaras
    expect(result().textContent).toMatch(/≈ 2 xícaras/);
  });
  it('massa → massa e volume → volume não exigem ingrediente e dizem se são exatas ou convencionais', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await u.selectOptions(screen.getByLabelText('Unidade de origem'), 'kg'); await u.selectOptions(screen.getByLabelText('Unidade de destino'), 'g');
    expect(result().textContent).toMatch(/1\.000 g/); expect(result().textContent).toMatch(/Conversão exata/);
    await u.selectOptions(screen.getByLabelText('Unidade de origem'), 'xic'); await u.selectOptions(screen.getByLabelText('Unidade de destino'), 'ml');
    expect(result().textContent).toMatch(/Medida culinária convencional/); expect(result().textContent).toMatch(/240 mL/);
  });
  it('peso ↔ volume sem ingrediente pede para escolher um; ingrediente sem referência avisa e permite ajustar', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    expect(within(result()).getByRole('alert').textContent).toMatch(/escolha um ingrediente/i);
    await u.type(screen.getByRole('combobox', { name: /Ingrediente/ }), 'ingrediente raro xyz');
    expect(await screen.findByText(/Não encontramos uma referência para este ingrediente/)).toBeTruthy();
  });
  it('ajustar a medida vale só para a conversão, tem prioridade e é identificado como informado por você', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'farinha de trigo', /^Farinha de trigo Catálogo$/);
    await u.click(screen.getByText(/Ajustar medida/));
    fireEvent.change(screen.getByLabelText(/Quanto pesa 1 xícara/), { target: { value: '100' } });
    expect(result().textContent).toMatch(/≈ 100 g/); expect(result().textContent).toMatch(/informado por você/);
    await u.click(screen.getByRole('button', { name: 'Usar a referência' }));
    expect(result().textContent).toMatch(/126,8 g/);
  });
  it('apresentações do catálogo (cru × cozido) mudam o resultado', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'arroz', /^Arroz branco Catálogo/);
    const sel = screen.getByRole('combobox', { name: 'Apresentação' }) as HTMLSelectElement;
    expect(result().textContent).toMatch(/≈ 187,7 g/);
    await u.selectOptions(sel, 'cozido'); expect(result().textContent).toMatch(/≈ 160,3 g/);
  });
  it('unidade → volume não tem significado físico e é recusada com explicação', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'ovo', /^Ovo Catálogo/);
    await u.selectOptions(screen.getByLabelText('Unidade de origem'), 'un'); await u.selectOptions(screen.getByLabelText('Unidade de destino'), 'ml');
    expect(within(result()).getByRole('alert').textContent).toMatch(/Não há como converter unidade em volume/);
    await u.selectOptions(screen.getByLabelText('Unidade de destino'), 'g'); expect(result().textContent).toMatch(/≈ 50 g/);
  });
  it('usa os ingredientes cadastrados do usuário (valor informado antes da referência)', async () => {
    await saveData({ schemaVersion: 3, ingredients: [{ id: 'f', name: 'Minha farinha especial', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, densityGPerMl: 0.6 }], recipes: [], orders: [] });
    const u = user(); render(<App />); await loaded(); await nav(u, 'Conversor');
    await pick(u, 'minha farinha', /Minha farinha especial/);
    fireEvent.change(screen.getByLabelText('Quantidade'), { target: { value: '1' } });
    expect(result().textContent).toMatch(/≈ 144 g/); expect(result().textContent).toMatch(/valor informado por você/);
  });
});
