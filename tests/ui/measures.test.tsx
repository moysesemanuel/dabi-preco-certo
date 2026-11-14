// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { makeRef } from '../../src/features/measurement/catalog';
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

const summary = () => screen.getByRole('group', { name: 'Medidas do ingrediente' });
const adjust = async (u: ReturnType<typeof user>) => { await u.click(within(summary()).getByRole('button', { name: /Ajustar|Adicionar medida/ })); return screen.findByRole('dialog', { name: 'Ajustar medidas' }); };
const apply = async (u: ReturnType<typeof user>) => { await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Aplicar' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); };
const cupField = () => screen.getByLabelText('Quanto pesa uma xícara (em gramas)?') as HTMLInputElement;
const flourSeed = (extra: Record<string, unknown> = {}) => ({ id: 'f', name: 'Farinha de trigo', purchaseQuantity: 1, unit: 'kg' as const, purchasePrice: 6, ...extra });
const seed = (ingredients: unknown[], recipes: unknown[] = [], orders: unknown[] = []) => saveData({ schemaVersion: 3, settings: { cupSizeMl: 240 }, ingredients, recipes, orders } as never);

describe('Cadastro simples de ingrediente', () => {
  it('cadastra com só os quatro campos: sem abrir ajustes, sem jargão e sem detalhes técnicos na tela', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    const form = screen.getByLabelText('Nome do ingrediente').closest('form')!;
    expect(form.querySelectorAll('input, select').length).toBe(4); // nome, quantidade, unidade, preço (nenhum campo de medida)
    expect(form.querySelector('details')).toBeNull();
    expect(within(summary()).getByText('Medidas não disponíveis')).toBeTruthy();
    expect(within(summary()).getByText('Você pode cadastrar este ingrediente normalmente.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await typeName(u, 'Ingrediente totalmente desconhecido'); await save(u);
    expect(await screen.findByText('Ingrediente cadastrado.')).toBeTruthy();
    expect(row('Ingrediente totalmente desconhecido').textContent).not.toMatch(/xícara/);
    for (const t of [/densidade/i, /USDA/, /catálogo/i, /FDC/, /versão/i]) expect(within(screen.getByRole('main')).queryByText(t)).toBeNull();
  });

  it('nome conhecido: o resumo mostra a referência encontrada (o que será usado) e salva sem abrir nada', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'FARINHA de Trigo');
    await waitFor(() => expect(within(summary()).getByText('Medidas encontradas')).toBeTruthy());
    expect(summary().textContent).toMatch(/1 xícara ≈ 126,8 g/); expect(summary().textContent).toMatch(/Referência culinária aproximada/);
    expect(summary().textContent).not.toMatch(/padrao|farinha-de-trigo|2026/); // sem ids nem versões
    expect(within(summary()).getByRole('button', { name: 'Ajustar' })).toBeTruthy();
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    expect(row('FARINHA de Trigo').textContent).toMatch(/1 xícara ≈ 126,8 g/);
  });

  it('nome incompleto ou desconhecido: "Medidas não disponíveis"; nada é inventado nem aplicado', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'farinha');
    expect(within(summary()).getByText('Medidas não disponíveis')).toBeTruthy(); expect(within(summary()).getByRole('button', { name: 'Adicionar medida' })).toBeTruthy();
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    expect(row('farinha').textContent).not.toMatch(/xícara/);
  });

  it('"Adicionar medida" abre os ajustes com busca de referência; escolher uma e aplicar atualiza o resumo', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'farinha'); await adjust(u);
    await u.type(screen.getByRole('combobox', { name: 'Buscar uma referência' }), 'farinha de arroz');
    await u.click(await screen.findByRole('option', { name: /Farinha de arroz/ }));
    await apply(u);
    expect(summary().textContent).toMatch(/Medidas encontradas/); expect(summary().textContent).toMatch(/1 xícara ≈ 160,3 g/);
  });

  it('medida personalizada: aparece como tal ("="), tem mensagem curta e o resumo reflete o que será usado', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar'); await adjust(u);
    fireEvent.change(cupField(), { target: { value: '180' } });
    expect(within(screen.getByRole('dialog')).getByText('Você está usando uma medida personalizada.')).toBeTruthy();
    await apply(u);
    expect(within(summary()).getByText('Medida personalizada')).toBeTruthy(); expect(summary().textContent).toMatch(/1 xícara = 180 g/);
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    expect(row('Açúcar').textContent).toMatch(/1 xícara = 180 g/);
    expect(screen.queryByText(/vale mais do que a referência/)).toBeNull();
  });

  it('editar: preserva a personalização, não a troca pela referência e permite restaurar a referência explicitamente', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar'); await adjust(u); fireEvent.change(cupField(), { target: { value: '180' } }); await apply(u); await save(u); await screen.findByText('Ingrediente cadastrado.');
    await u.click(screen.getByRole('button', { name: 'Editar Açúcar' }));
    expect(summary().textContent).toMatch(/Medida personalizada/); expect(summary().textContent).toMatch(/1 xícara = 180 g/); // continua o valor da pessoa
    await adjust(u);
    expect(cupField().value).toBe('180');
    await u.click(screen.getByText('Mais opções'));
    expect(screen.getByText(/Apaga as medidas que você informou e volta a usar a referência aproximada/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Restaurar valores do catálogo' }));
    expect(cupField().value).toBe('');
    await apply(u);
    expect(summary().textContent).toMatch(/Medidas encontradas/); expect(summary().textContent).toMatch(/≈ 20[23],\d g/);
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ })); await screen.findByText(/Ingrediente atualizado/);
    expect(row('Açúcar').textContent).toMatch(/≈ 20[23],\d g/); expect(row('Açúcar').textContent).not.toMatch(/=/);
  });

  it('remover referência é diferente de restaurar: desfaz a associação e mantém o que a pessoa informou', async () => {
    await seed([flourSeed({ catalogRef: makeRef('farinha-de-trigo'), gramsPerUnit: 70 })]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
    expect(summary().textContent).toMatch(/1 xícara ≈ 126,8 g/); expect(summary().textContent).toMatch(/1 unidade = 70 g/);
    await adjust(u); await u.click(screen.getByText('Mais opções'));
    expect(screen.getByText(/Desfaz a associação com “Farinha de trigo”/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Remover referência' }));
    await apply(u);
    expect(summary().textContent).toMatch(/Medida personalizada/); expect(summary().textContent).toMatch(/1 unidade = 70 g/); expect(summary().textContent).not.toMatch(/xícara/);
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ })); await screen.findByText(/Ingrediente atualizado/);
    expect(row('Farinha de trigo').textContent).toMatch(/1 unidade = 70 g/); expect(row('Farinha de trigo').textContent).not.toMatch(/xícara/);
  });

  it('a apresentação escolhida é preservada ao salvar e ao editar de novo', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar de confeiteiro'); await adjust(u);
    const sel = screen.getByRole('combobox', { name: 'Apresentação' }) as HTMLSelectElement;
    expect([...sel.options].map(o => o.text)).toEqual(['Sem peneirar', 'Peneirado']);
    await u.selectOptions(sel, 'peneirado'); await apply(u);
    expect(summary().textContent).toMatch(/Peneirado/); expect(summary().textContent).toMatch(/≈ 101,4 g/);
    await save(u); await screen.findByText('Ingrediente cadastrado.');
    await u.click(screen.getByRole('button', { name: 'Editar Açúcar de confeiteiro' }));
    expect(summary().textContent).toMatch(/Peneirado/); expect(summary().textContent).toMatch(/≈ 101,4 g/);
    await adjust(u); expect((screen.getByRole('combobox', { name: 'Apresentação' }) as HTMLSelectElement).value).toBe('peneirado');
  });

  it('cancelar os ajustes (botão, Esc ou fechar) não altera nada e devolve o foco ao botão de origem', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar');
    const before = summary().textContent;
    let dlg = await adjust(u); const opener = within(summary()).getByRole('button', { name: 'Ajustar' });
    fireEvent.change(cupField(), { target: { value: '999' } });
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(summary().textContent).toBe(before);
    dlg = await adjust(u); fireEvent.change(cupField(), { target: { value: '999' } });
    await u.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(summary().textContent).toBe(before); expect(document.activeElement).toBe(within(summary()).getByRole('button', { name: 'Ajustar' })); void opener;
    await adjust(u); await u.click(screen.getByRole('button', { name: 'Fechar sem salvar' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await adjust(u); expect(cupField().value).toBe(''); // o rascunho descartado não volta
  });

  it('cancelar a edição do ingrediente não modifica o registro', async () => {
    await seed([flourSeed({ densityGPerMl: 0.5 })]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
    await adjust(u); fireEvent.change(cupField(), { target: { value: '300' } }); await apply(u);
    await u.click(screen.getByRole('button', { name: /Cancelar/ }));
    expect(row('Farinha de trigo').textContent).toMatch(/1 xícara = 120 g/); // o registro continua igual
  });

  it('diálogo acessível: modal rotulado, foco dentro, Tab circula sem sair e validação de números', async () => {
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    await typeName(u, 'Açúcar'); const dlg = await adjust(u);
    expect(dlg.getAttribute('aria-modal')).toBe('true'); expect(dlg.contains(document.activeElement)).toBe(true);
    for (let n = 0; n < 12; n++) { await u.tab(); expect(dlg.contains(document.activeElement)).toBe(true); }
    fireEvent.change(cupField(), { target: { value: 'abc' } });
    expect(within(dlg).getByRole('alert').textContent).toMatch(/maiores que zero/); expect((within(dlg).getByRole('button', { name: 'Aplicar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('mudar as medidas avisa quais receitas mudaram de custo (sem tocar encomendas); nada muda por conta própria', async () => {
    await seed([flourSeed({ densityGPerMl: 0.5 })],
      [{ id: 'r', name: 'Bolo de teste', yield: 10, items: [{ ingredientId: 'f', quantity: 2, unit: 'xic' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
      [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', costSnapshot: { costPerUnit: 0.24, capturedAt: '2026-11-11T10:00:00.000Z' } }]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    expect(row('Farinha de trigo').textContent).toMatch(/1 xícara = 120 g/); // compatibilidade: o valor existente continua como era
    await u.click(screen.getByRole('button', { name: 'Editar Farinha de trigo' }));
    expect(summary().textContent).toMatch(/Medida personalizada/); // editar não adota referência sozinho
    await adjust(u); await u.click(screen.getByRole('button', { name: /Usar referência de “Farinha de trigo”/ }));
    fireEvent.change(cupField(), { target: { value: '' } }); await apply(u);
    await u.click(screen.getByRole('button', { name: /Salvar alterações/ }));
    const msg = await screen.findByText(/as medidas mudaram o cálculo/);
    expect(msg.textContent).toMatch(/1 receita mudou de custo por unidade: Bolo de teste \(R\$\s0,14 → R\$\s0,15\)/); expect(msg.textContent).toMatch(/Encomendas e custos já registrados não mudaram/);
  });

  it('ingredientes existentes (com valor antigo, com referência e sem nada) aparecem corretamente na lista', async () => {
    await seed([flourSeed({ id: 'a', name: 'Antigo', densityGPerMl: 0.5 }), flourSeed({ id: 'b', name: 'Com referência', catalogRef: makeRef('farinha-de-trigo') }), flourSeed({ id: 'c', name: 'Sem medidas' })]);
    const u = user(); render(<App />); await loaded(); await nav(u, 'Ingredientes');
    expect(row('Antigo').textContent).toMatch(/1 xícara = 120 g/); expect(row('Com referência').textContent).toMatch(/1 xícara ≈ 126,8 g/); expect(row('Sem medidas').textContent).not.toMatch(/xícara/);
    await u.click(screen.getByRole('button', { name: 'Editar Sem medidas' }));
    expect(within(summary()).getByText('Medidas não disponíveis')).toBeTruthy();
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
