import { asOrder } from './helpers/orders';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateDataSet } from '../shared/dataset';
import { applyEquivalences, updateIngredient } from '../src/domain/edit';
import { effectiveEquivalence } from '../src/domain/equivalence';
import { costImpact } from '../src/domain/impact';
import { captureCostSnapshot, itemUnitCost } from '../src/domain/orderCost';
import { recipeCost } from '../src/domain/pricing';
import type { DataSet, Ingredient, Order, Recipe } from '../src/domain/types';
import { CATALOG_VERSION, findItem, findVariant, makeRef } from '../src/features/measurement/catalog';
import { convert } from '../src/features/measurement/convert';
import { subjectFromCatalog, subjectFromIngredient } from '../src/features/measurement/subject';
import { formatQuantity } from '../src/features/measurement/units';
import { diffRows } from '../src/sync/describe';
import { emptyDataSet, isPendingConflict } from '../src/sync/engine';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

const US_CUP = 3785.411784 / 16;
const flour = () => subjectFromCatalog(findItem('farinha-de-trigo')!);
const sugar = () => subjectFromCatalog(findItem('acucar-refinado')!);
const eggs = () => subjectFromCatalog(findItem('ovo-inteiro')!);
const conv = (q: number, from: Parameters<typeof convert>[0]['from'], to: Parameters<typeof convert>[0]['to'], s?: { densityGPerMl?: number; gramsPerUnit?: number }, cup = 240) => convert({ quantity: q, from, to, densityGPerMl: s?.densityGPerMl, gramsPerUnit: s?.gramsPerUnit, cupSizeMl: cup });
const value = (r: ReturnType<typeof convert>) => (r.success ? r.value : NaN);

describe('Conversões com o catálogo', () => {
  it('massa ↔ massa e volume ↔ volume funcionam sem ingrediente, e são classificadas como exatas/convencionais', () => {
    expect(conv(1.5, 'kg', 'g')).toEqual({ success: true, value: 1500, approximate: false, basis: 'exact' });
    expect(conv(250, 'ml', 'l')).toEqual({ success: true, value: 0.25, approximate: false, basis: 'exact' });
    const c = conv(2, 'xic', 'ml'); expect(c).toMatchObject({ success: true, value: 480, basis: 'convention', approximate: true });
    expect(conv(1, 'cs', 'cc')).toMatchObject({ value: 3, basis: 'convention' });
    expect(conv(3, 'un', 'un')).toMatchObject({ basis: 'exact' });
  });
  it('volume → massa com referência conhecida (xícara de 240 mL, farinha ≈ 253,6 g para 2 xícaras)', () => {
    const r = conv(2, 'xic', 'g', flour());
    expect(r).toMatchObject({ success: true, basis: 'reference', approximate: true });
    expect(value(r)).toBeCloseTo(2 * 240 * 125 / US_CUP, 9); expect(formatQuantity(value(r), 'g')).toBe('253,6');
  });
  it('massa → volume e a conversão inversa devolvem o valor de origem', () => {
    const grams = value(conv(2, 'xic', 'g', sugar())), back = value(conv(grams, 'g', 'xic', sugar()));
    expect(back).toBeCloseTo(2, 12);
    expect(value(conv(120, 'g', 'xic', flour()))).toBeCloseTo(120 * US_CUP / (125 * 240), 9);
    expect(value(conv(1, 'cs', 'g', sugar()))).toBeCloseTo(15 * 200 / US_CUP, 9); // colher de sopa = 15 mL
  });
  it('o tamanho da xícara altera o peso de uma xícara (200, 240 e 250 mL)', () => {
    const g = (cup: number) => value(conv(1, 'xic', 'g', flour(), cup));
    expect(g(200)).toBeLessThan(g(240)); expect(g(250) / g(200)).toBeCloseTo(250 / 200, 12);
  });
  it('frações e decimais entram como números; o arredondamento é só de exibição', () => {
    expect(formatQuantity(value(conv(0.5, 'xic', 'g', flour())), 'g')).toBe('63,4');
    expect(value(conv(1 / 3, 'xic', 'g', flour()))).toBeCloseTo(value(conv(1, 'xic', 'g', flour())) / 3, 12);
    expect(formatQuantity(value(conv(0.0001, 'xic', 'g', flour())), 'g')).toBe('0'); // exibição; o valor interno não é arredondado
    expect(value(conv(0.0001, 'xic', 'g', flour()))).toBeGreaterThan(0);
  });
  it('unidade → peso usa o peso por unidade do catálogo (ovo grande = 50 g) e respeita a apresentação', () => {
    expect(value(conv(2, 'un', 'g', eggs()))).toBe(100);
    expect(value(conv(100, 'g', 'un', eggs()))).toBe(2);
    const jumbo = subjectFromCatalog(findItem('ovo-inteiro')!, 'jumbo'); expect(value(conv(2, 'un', 'g', jumbo))).toBe(126);
  });
  it('apresentações diferentes dão pesos diferentes (confeiteiro peneirado × sem peneirar)', () => {
    const item = findItem('acucar-de-confeiteiro')!;
    const sifted = value(conv(1, 'xic', 'g', subjectFromCatalog(item, 'peneirado'))), loose = value(conv(1, 'xic', 'g', subjectFromCatalog(item, 'sem-peneirar')));
    expect(sifted / loose).toBeCloseTo(100 / 120, 9);
  });
  it('sem equivalência não converte (nunca inventa): sem ingrediente, ou sem a medida no catálogo', () => {
    expect(conv(1, 'xic', 'g')).toEqual({ success: false, error: 'MISSING_DENSITY' });
    expect(conv(1, 'un', 'g', flour())).toEqual({ success: false, error: 'MISSING_UNIT_EQUIVALENCE' }); // farinha não tem peso por unidade
    expect(conv(1, 'xic', 'g', { gramsPerUnit: 50 })).toEqual({ success: false, error: 'MISSING_DENSITY' }); // ovo não tem densidade
    expect(conv(1, 'un', 'ml', eggs())).toEqual({ success: false, error: 'MISSING_UNIT_EQUIVALENCE' }); // unidade → volume: sem significado
  });
  it('subject de ingrediente cadastrado: valor informado tem prioridade sobre a referência', () => {
    const ing: Ingredient = { id: 'f', name: 'Farinha', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, catalogRef: makeRef('farinha-de-trigo')!, densityGPerMl: 0.6 };
    const s = subjectFromIngredient(ing);
    expect(s.densityGPerMl).toBe(0.6); expect(s.densitySource).toBe('custom'); expect(s.reference).toMatch(/Farinha de trigo/);
    const onlyRef = subjectFromIngredient({ ...ing, densityGPerMl: undefined });
    expect(onlyRef.densitySource).toBe('catalog'); expect(onlyRef.densityGPerMl).toBeCloseTo(125 / US_CUP, 9);
    expect(subjectFromIngredient({ id: 'x', name: 'Raro', purchaseQuantity: 1, unit: 'g', purchasePrice: 1 })).toMatchObject({ densitySource: 'none', unitSource: 'none' });
  });
});

describe('Receitas, custos e histórico', () => {
  const base = (): DataSet => ({ schemaVersion: 3, settings: { cupSizeMl: 240 }, ingredients: [{ id: 'f', name: 'Farinha de trigo', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6 }, { id: 'o', name: 'Ovos', purchaseQuantity: 12, unit: 'un', purchasePrice: 12 }],
    recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 2, unit: 'xic' }, { ingredientId: 'o', quantity: 3, unit: 'un' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
    orders: [] });
  const cost = (d: DataSet) => recipeCost(d.recipes[0], d.ingredients, 240);
  it('sem equivalência a receita antiga continua não calculável (nada é inferido sozinho)', () => {
    expect(() => cost(base())).toThrow(/Farinha de trigo/);
  });
  it('comprado em kg e usado em xícaras com a referência do catálogo', () => {
    const d = applyEquivalences(base(), [{ ingredientId: 'f', patch: { catalogRef: makeRef('farinha-de-trigo')! } }, { ingredientId: 'o', patch: { catalogRef: makeRef('ovo-inteiro')! } }]);
    const line = cost(d).lines.find(l => l.ingredientId === 'f')!;
    expect(line.convertedUnit).toBe('kg'); expect(line.convertedQuantity).toBeCloseTo(2 * 240 * 125 / US_CUP / 1000, 9); expect(line.approximate).toBe(true);
    expect(line.cost).toBeCloseTo(6 * line.convertedQuantity, 12);
  });
  it('comprado em g e usado em colheres; comprado em un e usado em g (peso por unidade)', () => {
    const g: Ingredient = { id: 'a', name: 'Açúcar', purchaseQuantity: 1000, unit: 'g', purchasePrice: 5, catalogRef: makeRef('acucar-refinado')! };
    const r: Recipe = { id: 'r2', name: 'Doce', yield: 1, items: [{ ingredientId: 'a', quantity: 2, unit: 'cs' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 0 };
    expect(recipeCost(r, [g], 240).lines[0].convertedQuantity).toBeCloseTo(2 * 15 * 200 / US_CUP, 9);
    const egg: Ingredient = { id: 'e', name: 'Ovo', purchaseQuantity: 12, unit: 'un', purchasePrice: 12, catalogRef: makeRef('ovo-inteiro')! };
    const r3: Recipe = { ...r, id: 'r3', items: [{ ingredientId: 'e', quantity: 100, unit: 'g' }] };
    expect(recipeCost(r3, [egg], 240).lines[0].convertedQuantity).toBe(2); // 100 g = 2 ovos de 50 g
  });
  it('valor informado pelo usuário tem prioridade sobre a referência', () => {
    const d = applyEquivalences(base(), [{ ingredientId: 'f', patch: { catalogRef: makeRef('farinha-de-trigo')! } }, { ingredientId: 'o', patch: { catalogRef: makeRef('ovo-inteiro')! } }]);
    const mine = updateIngredient(d, 'f', { ...d.ingredients[0], densityGPerMl: 0.5 });
    expect(cost(mine).lines[0].convertedQuantity).toBeCloseTo(2 * 240 * 0.5 / 1000, 12);
    expect(effectiveEquivalence(mine.ingredients[0])).toMatchObject({ densityGPerMl: 0.5, densitySource: 'custom' });
  });
  it('atualizar o catálogo NÃO muda custos: a referência adotada guarda os valores congelados', () => {
    const old = { id: 'farinha-de-trigo', variant: 'padrao', version: '2025.01.1', densityGPerMl: 0.5 };
    const d: DataSet = { ...base(), ingredients: base().ingredients.map(i => (i.id === 'f' ? { ...i, catalogRef: old } : { ...i, catalogRef: makeRef('ovo-inteiro')! })) };
    expect(cost(d).lines[0].convertedQuantity).toBeCloseTo(2 * 240 * 0.5 / 1000, 12); // usa 0,5 (congelado), não o valor atual do catálogo
    expect(old.version).not.toBe(CATALOG_VERSION);
  });
  it('identifica quando uma nova equivalência muda o cálculo (e quando não muda)', () => {
    const withRef = applyEquivalences(base(), [{ ingredientId: 'f', patch: { catalogRef: makeRef('farinha-de-trigo')! } }, { ingredientId: 'o', patch: { catalogRef: makeRef('ovo-inteiro')! } }]);
    const changes = costImpact(base(), withRef);
    expect(changes).toHaveLength(1); expect(changes[0]).toMatchObject({ recipeId: 'r', name: 'Bolo', before: undefined }); expect(changes[0].after).toBeGreaterThan(0);
    expect(costImpact(withRef, withRef)).toEqual([]);
    const mine = updateIngredient(withRef, 'f', { ...withRef.ingredients[0], densityGPerMl: 0.9 });
    const c2 = costImpact(withRef, mine); expect(c2).toHaveLength(1); expect(c2[0].after!).toBeGreaterThan(c2[0].before!);
  });
  it('encomendas e snapshots financeiros não são recalculados quando as equivalências mudam', () => {
    const d = applyEquivalences(base(), [{ ingredientId: 'f', patch: { catalogRef: makeRef('farinha-de-trigo')! } }, { ingredientId: 'o', patch: { catalogRef: makeRef('ovo-inteiro')! } }]);
    const snap = captureCostSnapshot(d.recipes[0], d, new Date('2026-11-11T10:00:00Z'))!;
    const order: Order = asOrder({ id: 'ord', customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 20, deposit: 5, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', costSnapshot: snap, payments: [{ id: 'p', amount: 10, receivedAt: '2026-11-12' }] });
    const withOrder = { ...d, orders: [order] };
    const changed = updateIngredient(withOrder, 'f', { ...withOrder.ingredients[0], densityGPerMl: 0.9, catalogRef: undefined });
    expect(changed.orders[0]).toEqual(order); expect(changed.orders[0].items[0].costSnapshot).toEqual(snap);
    expect(cost(changed).costPerUnit).not.toBe(snap.costPerUnit); // o custo ATUAL da receita muda; o registrado na encomenda, não
    expect(itemUnitCost(changed.orders[0].items[0], changed)).toEqual({ basis: 'recorded', costPerUnit: snap.costPerUnit });
  });
});

describe('Backup e validação', () => {
  const ds = (ing: Record<string, unknown>) => ({ schemaVersion: 3, ingredients: [{ id: 'f', name: 'Farinha', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, ...ing }], recipes: [], orders: [] });
  it('backup antigo (sem referência) continua válido e inalterado', () => {
    const out = validateDataSet(ds({ densityGPerMl: 0.5 })); expect(out.ingredients[0]).toEqual({ id: 'f', name: 'Farinha', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, densityGPerMl: 0.5 });
  });
  it('a referência do catálogo e o valor do usuário sobrevivem a exportar → restaurar, separados', () => {
    const ref = makeRef('farinha-de-trigo')!;
    const out = validateDataSet(JSON.parse(JSON.stringify(ds({ catalogRef: ref, densityGPerMl: 0.6 }))));
    expect(out.ingredients[0].catalogRef).toEqual(ref); expect(out.ingredients[0].densityGPerMl).toBe(0.6);
  });
  it('referência malformada é recusada (dados externos são tratados como não confiáveis)', () => {
    for (const bad of [{ id: 'X Y', variant: 'padrao', version: '1' }, { id: 'a', variant: '', version: '1' }, { id: 'a', variant: 'b', version: 'v'.repeat(40) }, { id: 'a', variant: 'b', version: '1', densityGPerMl: -1 }, 'texto', 42])
      expect(() => validateDataSet(ds({ catalogRef: bad })), JSON.stringify(bad)).toThrow(/Referência de medidas|ingrediente|Ingrediente/i);
  });
  it('referência de uma versão futura/desconhecida do catálogo não invalida o backup', () => {
    expect(validateDataSet(ds({ catalogRef: { id: 'item-que-so-existe-no-futuro', variant: 'padrao', version: '2030.01.1', densityGPerMl: 0.7 } })).ingredients[0].catalogRef?.id).toBe('item-que-so-existe-no-futuro');
  });
});

describe('Sincronização entre sessões (Worker real, com a migração 0007)', () => {
  let srv: Server;
  beforeEach(async () => { srv = makeServer(); await srv.issueFor('bia@exemplo.com'); });
  const device = async (label: string) => new Device(srv, await srv.login('bia@exemplo.com', label));
  const ingredient = (over: Partial<Ingredient> = {}): Ingredient => ({ id: 'farinha', name: 'Farinha de trigo', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6, ...over });
  const data = (i: Ingredient): DataSet => ({ ...emptyDataSet(), ingredients: [i] });

  it('a referência adotada e o valor informado chegam idênticos ao outro dispositivo', async () => {
    const A = await device('A'), B = await device('B');
    const ref = makeRef('farinha-de-trigo')!;
    A.edit(() => data(ingredient({ catalogRef: ref, gramsPerUnit: 70 }))); expect((await A.sync()).status).toBe('synced');
    await B.sync();
    expect(B.data.ingredients[0]).toEqual(A.data.ingredients[0]); expect(B.data.ingredients[0].catalogRef).toEqual(ref);
    expect(JSON.parse(srv.table('ingredients')[0].catalog_ref as string)).toEqual(ref);
  });
  it('ingredientes sem referência continuam sem coluna preenchida (compatibilidade)', async () => {
    const A = await device('A'); A.edit(() => data(ingredient({ densityGPerMl: 0.5 }))); await A.sync();
    expect(srv.table('ingredients')[0].catalog_ref).toBeNull(); expect(srv.table('ingredients')[0].density_g_per_ml).toBe(0.5);
  });
  it('remover a referência também sincroniza', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => data(ingredient({ catalogRef: makeRef('farinha-de-trigo')! }))); await A.sync(); await B.sync();
    A.edit(() => data(ingredient())); await A.sync(); await B.sync();
    expect(B.data.ingredients[0].catalogRef).toBeUndefined(); expect(srv.table('ingredients')[0].catalog_ref).toBeNull();
  });
  it('personalizações conflitantes viram conflito pendente (nada é sobrescrito) e aparecem com rótulos claros', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => data(ingredient({ catalogRef: makeRef('farinha-de-trigo')! }))); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: [{ ...d.ingredients[0], densityGPerMl: 0.55 }] }));
    B.edit(d => ({ ...d, ingredients: [{ ...d.ingredients[0], densityGPerMl: 0.45 }] })); await B.sync();
    await A.sync();
    const [c] = A.meta.conflicts.filter(isPendingConflict);
    expect(c).toBeDefined(); expect(A.data.ingredients[0].densityGPerMl).toBe(0.55); // a minha personalização continua
    expect(diffRows(c).map(r => r.label)).toContain('Densidade (g/ml)');
    A.resolve(c.id, 'keep-server'); expect(A.data.ingredients[0].densityGPerMl).toBe(0.45);
  });
  it('trocar a referência em um dispositivo e uma personalização em outro: conflito pendente com a referência legível', async () => {
    const A = await device('A'), B = await device('B');
    A.edit(() => data(ingredient({ catalogRef: makeRef('farinha-de-trigo')! }))); await A.sync(); await B.sync();
    A.edit(d => ({ ...d, ingredients: [{ ...d.ingredients[0], catalogRef: makeRef('farinha-de-trigo-integral')! }] }));
    B.edit(d => ({ ...d, ingredients: [{ ...d.ingredients[0], catalogRef: makeRef('farinha-de-arroz')! }] })); await B.sync(); await A.sync();
    const [c] = A.meta.conflicts.filter(isPendingConflict);
    expect(diffRows(c)).toEqual([expect.objectContaining({ label: 'Medidas de referência', local: 'Farinha de trigo integral', server: 'Farinha de arroz' })]);
  });
  it('referência é isolada por conta: outra conta não recebe a de Bia', async () => {
    await srv.issueFor('carla@exemplo.com');
    const A = await device('A'); A.edit(() => data(ingredient({ catalogRef: makeRef('farinha-de-trigo')! }))); await A.sync();
    const C = new Device(srv, await srv.login('carla@exemplo.com', 'C')); await C.sync();
    expect(C.data.ingredients).toEqual([]);
  });
  it('item do catálogo ausente na versão instalada não quebra a leitura', () => {
    expect(findVariant(findItem('farinha-de-trigo')!, 'x').id).toBe('padrao');
  });
});
