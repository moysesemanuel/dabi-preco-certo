import { describe, expect, it } from 'vitest';
import { DATASET_LIMITS, isIsoDate, isIsoDateTime, migrateStored, validateDataSet } from '../shared/dataset';
import { emptyData } from '../src/storage/db';

const base = () => ({
  schemaVersion: 3,
  ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1000, unit: 'g', purchasePrice: 6 }, { id: 'a', name: 'Açúcar', purchaseQuantity: 1, unit: 'kg', purchasePrice: 5 }],
  recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500, unit: 'g' }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 }],
  orders: [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 5, deposit: 3, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', costSnapshot: { costPerUnit: 4, capturedAt: '2026-11-11T10:00:00.000Z' } }],
});
type Tree = ReturnType<typeof base>;
const mutate = (fn: (d: Tree) => void) => { const d = base(); fn(d); return d; };
const bad = (fn: (d: Tree) => void, message: string | RegExp) => expect(() => validateDataSet(mutate(fn))).toThrow(message);

describe('Validação estrita do conjunto de dados', () => {
  it('aceita dados válidos, inclusive o conjunto vazio, e devolve cópia normalizada', () => {
    expect(validateDataSet(base())).toEqual(base());
    expect(validateDataSet(emptyData())).toEqual(emptyData());
  });
  it('rejeita identificadores duplicados em cada coleção', () => {
    bad(d => { d.ingredients[1].id = 'f'; }, /Ingrediente.*duplicado/);
    bad(d => { d.recipes.push({ ...d.recipes[0] }); }, /Receita.*duplicado/);
    bad(d => { d.orders.push({ ...d.orders[0] }); }, /Encomenda.*duplicado/);
  });
  it('rejeita identificadores vazios, longos ou com caracteres estranhos', () => {
    for (const id of ['', 'x'.repeat(65), 'a b', '<script>', '../x', 5 as unknown as string]) bad(d => { d.ingredients[0].id = id; d.recipes[0].items[0].ingredientId = id; }, /Ingrediente/);
  });
  it('rejeita relacionamentos quebrados', () => {
    bad(d => { d.recipes[0].items[0].ingredientId = 'nao-existe'; }, /Receita.*ingrediente inexistente/);
    bad(d => { d.orders[0].recipeId = 'nao-existe'; }, /Encomenda.*receita inexistente/);
  });
  it('rejeita valores monetários e quantidades inválidos', () => {
    for (const v of [-1, NaN, Infinity, '5', null, 1e12]) {
      bad(d => { (d.ingredients[0] as { purchasePrice: unknown }).purchasePrice = v; }, /Ingrediente/);
      bad(d => { (d.orders[0] as { unitPrice: unknown }).unitPrice = v; }, /Encomenda/);
      bad(d => { (d.recipes[0] as { laborTotal: unknown }).laborTotal = v; }, /Receita/);
    }
    for (const q of [0, -2, NaN, Infinity]) {
      bad(d => { d.orders[0].quantity = q; }, /Encomenda/);
      bad(d => { d.recipes[0].yield = q; }, /Receita/);
      bad(d => { d.ingredients[0].purchaseQuantity = q; }, /Ingrediente/);
    }
  });
  it('rejeita sinal maior que o total, datas inválidas e status desconhecido', () => {
    bad(d => { d.orders[0].deposit = 10.01; }, /sinal maior/);
    expect(validateDataSet(mutate(d => { d.orders[0].deposit = 10; })).orders[0].deposit).toBe(10);
    for (const date of ['2026-02-31', '11/11/2026', '', 'amanhã']) bad(d => { d.orders[0].deliveryDate = date; }, /data de entrega/);
    for (const when of ['2026-11-11', 'ontem', '2026-13-01T00:00:00Z']) bad(d => { d.orders[0].createdAt = when; }, /data de criação/);
    bad(d => { d.orders[0].status = 'Cancelado'; }, /status/);
  });
  it('rejeita valores monetários com frações menores que um centavo', () => {
    bad(d => { d.orders[0].payments = [{ id: 'p1', amount: 0.014, receivedAt: '2026-11-11' }]; }, /recebimento.*valor inválido/);
    bad(d => { d.orders[0].deposit = 0.015; }, /Encomenda.*duas casas decimais/);
    bad(d => { d.ingredients[0].purchasePrice = 1.005; }, /Ingrediente.*duas casas decimais/);
  });
  it('valida o custo registrado (snapshot)', () => {
    bad(d => { (d.orders[0].costSnapshot as { costPerUnit: unknown }).costPerUnit = -1; }, /custo registrado/);
    bad(d => { (d.orders[0].costSnapshot as { capturedAt: unknown }).capturedAt = 'hoje'; }, /custo registrado/);
    bad(d => { (d.orders[0] as { costSnapshot: unknown }).costSnapshot = 'x'; }, /custo registrado/);
  });
  it('valida margem, itens da receita, medidas e configurações', () => {
    bad(d => { d.recipes[0].desiredMargin = 100; }, /margem/);
    bad(d => { d.recipes[0].items[0].quantity = -1; }, /quantidade/);
    bad(d => { (d.recipes[0].items[0] as { unit: string }).unit = 'balde'; }, /medida/);
    bad(d => { (d.ingredients[0] as { unit: string }).unit = 'xx'; }, /unidade/);
    bad(d => { (d as Tree & { settings: unknown }).settings = { cupSizeMl: -1 }; }, 'Configurações');
    bad(d => { (d as Tree & { settings: unknown }).settings = { cupSizeMl: 5000 }; }, 'Configurações');
  });
  it('rejeita formatos e versões incompatíveis e backups grandes demais', () => {
    for (const v of [null, 'x', 5, [], {}]) expect(() => validateDataSet(v)).toThrow();
    bad(d => { d.schemaVersion = 4; }, 'incompatível');
    bad(d => { (d as { ingredients: unknown }).ingredients = {}; }, 'incompatível');
    expect(() => validateDataSet({ ...base(), orders: new Array(DATASET_LIMITS.orders + 1).fill(base().orders[0]) })).toThrow('grande demais');
  });
  it('descarta campos desconhecidos (não carrega lixo nem __proto__)', () => {
    const d = mutate(x => { Object.assign(x.orders[0], { evil: '<script>', __proto__: { polluted: true } }); Object.assign(x.ingredients[0], { cost: 99 }); });
    const out = validateDataSet(JSON.parse(JSON.stringify(d)));
    expect(Object.keys(out.orders[0])).not.toContain('evil'); expect(Object.keys(out.ingredients[0])).not.toContain('cost');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('datas auxiliares', () => {
    expect(isIsoDate('2028-02-29')).toBe(true); expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDateTime('2026-11-11T10:00:00Z')).toBe(true); expect(isIsoDateTime('2026-11-11T25:00:00Z')).toBe(false);
  });
});

describe('Migração de dados', () => {
  it('backup v1 é aceito, vira v3 e as encomendas antigas continuam SEM custo registrado', () => {
    const v1 = mutate(d => { d.schemaVersion = 1; delete (d.orders[0] as { costSnapshot?: unknown }).costSnapshot; });
    const out = validateDataSet(v1);
    expect(out.schemaVersion).toBe(3);
    expect(out.orders[0].costSnapshot).toBeUndefined();
    expect(out.orders[0]).toMatchObject({ id: 'o', quantity: 2, unitPrice: 5, deposit: 3 });
  });
  it('migrateStored não rejeita nem perde dados antigos, mesmo "imperfeitos"', () => {
    const odd = { schemaVersion: 1, ingredients: [{ id: 'f', name: 'F', purchaseQuantity: 1, unit: 'g', purchasePrice: 1, gramsPerCup: 120 }], recipes: [], orders: [{ id: 'o', customer: 'X', recipeId: 'sumiu', quantity: 1, unitPrice: 1, deposit: 5, deliveryDate: 'qualquer', status: 'Entregue', createdAt: 'x' }] };
    const out = migrateStored(odd);
    expect(out.schemaVersion).toBe(3);
    expect(out.orders).toHaveLength(1); expect(out.orders[0].id).toBe('o');
    expect(out.ingredients[0]).toMatchObject({ densityGPerMl: 0.5 }); expect('gramsPerCup' in out.ingredients[0]).toBe(false);
    expect(() => validateDataSet(odd)).toThrow(); // o mesmo dado seria rejeitado como BACKUP, mas continua legível no navegador
  });
  it('migrateStored tolera lixo estrutural sem lançar erro', () => {
    for (const raw of [null, undefined, 'x', 5, {}, { ingredients: 'x', orders: null }]) {
      const out = migrateStored(raw);
      expect(out).toMatchObject({ schemaVersion: 3, ingredients: [], recipes: [], orders: [] });
    }
  });
  it('migrar duas vezes dá o mesmo resultado (idempotente)', () => {
    const once = migrateStored(base());
    expect(migrateStored(once)).toEqual(once);
  });
});
