import { describe, expect, it } from 'vitest';
import { applyEquivalences } from '../src/domain/edit';
import { recipeCost } from '../src/domain/pricing';
import type { DataSet, Ingredient } from '../src/domain/types';
import { findReference } from '../src/features/measurement/densities';
import { parseIngredientList } from '../src/features/recipe-import/parse';
import { analyzeRow, buildImport, matchRegistered, rowFromParsed, type ImportRow } from '../src/features/recipe-import/resolve';

const TEXT = `2 ovos
1 xícara (chá) de açúcar
½ xícara (chá) de leite
2 xícaras (chá) de farinha de trigo
1 colher (sopa) de fermento químico
Óleo para fritar`;

const registered = (): Ingredient[] => [
  { id: 'farinha', name: 'Farinha de trigo', purchaseQuantity: 1, unit: 'kg', purchasePrice: 6 },
  { id: 'acucar', name: 'Açúcar', purchaseQuantity: 1, unit: 'kg', purchasePrice: 5 },
  { id: 'leite', name: 'Leite', purchaseQuantity: 1, unit: 'l', purchasePrice: 5 },
  { id: 'ovos', name: 'Ovos', purchaseQuantity: 12, unit: 'un', purchasePrice: 12 },
  { id: 'fermento', name: 'Fermento em pó', purchaseQuantity: 100, unit: 'g', purchasePrice: 6 },
  { id: 'oleo', name: 'Óleo de soja', purchaseQuantity: 0.9, unit: 'l', purchasePrice: 8 },
];
const rowsFor = (text: string, ings = registered()): ImportRow[] => parseIngredientList(text).map((p, i) => rowFromParsed(p, i, ings));
const analyze = (text: string, ings = registered()) => rowsFor(text, ings).map(r => analyzeRow(r, ings));

describe('Sinônimos e correspondência', () => {
  it('fermento em pó, fermento químico e pó Royal apontam para a mesma referência', () => {
    const a = findReference('fermento em pó'), b = findReference('Fermento químico'), c = findReference('pó Royal');
    expect(a).toBeDefined(); expect(a).toBe(b); expect(b).toBe(c);
  });
  it('"pó Royal" encontra o ingrediente cadastrado como "Fermento em pó"', () => {
    expect(matchRegistered('pó Royal', registered())?.id).toBe('fermento');
    expect(matchRegistered('fermento químico', registered())?.id).toBe('fermento');
  });
  it('plural, qualificadores e acentos não impedem a correspondência', () => {
    expect(matchRegistered('ovos grandes', registered())?.id).toBe('ovos');
    expect(matchRegistered('FARINHA DE TRIGO peneirada', registered())?.id).toBe('farinha');
    expect(matchRegistered('oleo de soja', registered())?.id).toBe('oleo');
  });
  it('ingredientes desconhecidos ou parecidos não casam', () => {
    expect(matchRegistered('leite condensado', registered())).toBeUndefined();
    expect(matchRegistered('farinha de mandioca', registered())).toBeUndefined();
    expect(matchRegistered('biscoito maisena', registered())).toBeUndefined();
  });
});

describe('Conversão da lista de exemplo', () => {
  const [ovos, acucar, leite, farinha, fermento, oleo] = analyze(TEXT);
  it('ovos: 2 unidades ≈ 100 g', () => { expect(ovos.grams).toBeCloseTo(100, 9); expect(ovos.approximate).toBe(true); });
  it('açúcar: 1 xícara = 200 g', () => expect(acucar.grams).toBeCloseTo(200, 9));
  it('leite: ½ xícara = 120 mL ≈ 124 g', () => { expect(leite.ml).toBeCloseTo(120, 9); expect(leite.grams).toBeCloseTo(123.5, 9); });
  it('farinha: 2 xícaras = 240 g', () => expect(farinha.grams).toBeCloseTo(240, 9));
  it('fermento químico: 1 colher de sopa ≈ 12 g', () => expect(fermento.grams).toBeCloseTo(12, 9));
  it('óleo para fritar: quantidade a informar, sem custo', () => {
    expect(oleo.ready).toBe(false); expect(oleo.item).toBeUndefined(); expect(oleo.issues.join(' ')).toContain('Quantidade indefinida');
  });
  it('marca os valores aproximados e cita a referência usada', () => {
    expect(farinha.approximate).toBe(true);
    expect(farinha.references[0]).toContain('referência aproximada');
    expect(farinha.references[0]).toContain('120');
  });
  it('preserva a medida original no item de receita', () => {
    expect(farinha.item).toEqual({ ingredientId: 'farinha', quantity: 2, unit: 'xic' });
    expect(ovos.item).toEqual({ ingredientId: 'ovos', quantity: 2, unit: 'un' });
  });
  it('edição manual do óleo (ex.: 2 xícaras) o torna importável', () => {
    const ings = registered();
    const rows = rowsFor(TEXT, ings);
    const edited = { ...rows[5], quantity: '1', unit: 'xic' as const };
    const a = analyzeRow(edited, ings);
    expect(a.ready).toBe(true); expect(a.grams).toBeCloseTo(221, 9);
  });
});

describe('Densidade ausente e ingredientes desconhecidos', () => {
  it('farinha de mandioca sem densidade cadastrada nem referência: bloqueia, sem inventar valor', () => {
    const ings = [...registered(), { id: 'mand', name: 'Farinha de mandioca', purchaseQuantity: 1, unit: 'kg' as const, purchasePrice: 8 }];
    const [a] = analyze('1 xícara de farinha de mandioca', ings);
    expect(a.ready).toBe(false); expect(a.item).toBeUndefined(); expect(a.grams).toBeUndefined();
    expect(a.issues.join(' ')).toMatch(/Farinha de mandioca.*xícara/);
  });
  it('ingrediente não cadastrado: converte o peso (se houver referência) mas não importa', () => {
    const ings = registered().filter(i => i.id !== 'manteiga');
    const [a] = analyze('1 xícara de manteiga', ings);
    expect(a.grams).toBeCloseTo(227, 9); expect(a.ready).toBe(false); expect(a.issues.join(' ')).toContain('não está cadastrado');
  });
  it('ingrediente totalmente desconhecido: sem peso inventado e sem importação', () => {
    const [a] = analyze('1 xícara de biscoito maisena');
    expect(a.grams).toBeUndefined(); expect(a.ml).toBeCloseTo(240, 9); expect(a.ready).toBe(false); expect(a.issues.join(' ')).toContain('não reconhecido');
  });
  it('medida desconhecida (pitada) exige escolha da pessoa', () => {
    const [a] = analyze('1 pitada de sal');
    expect(a.ready).toBe(false); expect(a.issues.join(' ')).toContain('pitada');
  });
  it('o cadastro do ingrediente tem prioridade sobre a referência', () => {
    const ings = registered().map(i => (i.id === 'farinha' ? { ...i, densityGPerMl: 0.6 } : i));
    const [a] = analyze('1 xícara de farinha de trigo', ings);
    expect(a.grams).toBeCloseTo(144, 9); expect(a.references[0]).toContain('cadastro do ingrediente'); expect(a.patch).toBeUndefined();
  });
  it('xícara de 250 mL altera a conversão', () => {
    const ings = registered();
    const row = rowsFor('1 xícara de farinha de trigo', ings)[0];
    expect(analyzeRow(row, ings, 250).grams).toBeCloseTo(125, 9);
  });
});

describe('Integração com receitas e precificação', () => {
  it('importa só as linhas completas e calcula o custo com as equivalências confirmadas', () => {
    const ings = registered();
    const { items, patches, blocked } = buildImport(rowsFor(TEXT, ings), ings);
    expect(items.map(i => i.ingredientId)).toEqual(['ovos', 'acucar', 'leite', 'farinha', 'fermento']);
    expect(blocked).toBe(1); // óleo sem quantidade
    const data: DataSet = { schemaVersion: 1, ingredients: ings, recipes: [], orders: [] };
    const next = applyEquivalences(data, patches);
    const cost = recipeCost({ id: 'r', name: 'Bolo', yield: 10, items, packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }, next.ingredients);
    // farinha 1,44 + açúcar 1,00 + leite 0,60 + ovos 2,00 + fermento 0,72
    expect(cost.materials).toBe(5.76);
    expect(cost.lines.find(l => l.ingredientId === 'farinha')).toMatchObject({ quantity: 2, unit: 'xic', convertedUnit: 'kg', approximate: true });
  });
  it('sem gravar a equivalência, a receita não calcula (nunca assume custo zero)', () => {
    const ings = registered();
    const { items } = buildImport(rowsFor(TEXT, ings), ings);
    expect(() => recipeCost({ id: 'r', name: 'Bolo', yield: 10, items, packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }, ings)).toThrow(/densidade/);
  });
  it('gravar equivalência preenche só o que está em branco e não sobrescreve', () => {
    const ings = registered().map(i => (i.id === 'farinha' ? { ...i, densityGPerMl: 0.6 } : i));
    const data: DataSet = { schemaVersion: 1, ingredients: ings, recipes: [], orders: [] };
    const next = applyEquivalences(data, [{ ingredientId: 'farinha', patch: { densityGPerMl: 0.5, gramsPerUnit: 70 } }, { ingredientId: 'inexistente', patch: { densityGPerMl: 1 } }]);
    const f = next.ingredients.find(i => i.id === 'farinha')!;
    expect(f.densityGPerMl).toBe(0.6); expect(f.gramsPerUnit).toBe(70);
  });
  it('linhas desmarcadas ou bloqueadas não entram; o resumo conta os bloqueios', () => {
    const ings = registered();
    const rows = rowsFor(TEXT, ings).map((r, i) => (i === 0 ? { ...r, include: false } : r));
    const { items, blocked } = buildImport(rows, ings);
    expect(items.some(i => i.ingredientId === 'ovos')).toBe(false); expect(blocked).toBe(1);
  });
  it('linha com quantidade inválida editada à mão é bloqueada', () => {
    const ings = registered();
    const [row] = rowsFor('2 ovos', ings);
    for (const quantity of ['abc', '-1', '']) expect(analyzeRow({ ...row, quantity }, ings).ready).toBe(false);
    expect(analyzeRow({ ...row, quantity: '1,5' }, ings).ready).toBe(true);
  });
});
