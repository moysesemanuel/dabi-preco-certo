import { describe, expect, it } from 'vitest';
import { parseIngredientLine, parseIngredientList, parseQuantity } from '../src/features/recipe-import/parse';

const q = (s: string) => parseQuantity(s)?.value;
const line = (s: string) => parseIngredientLine(s)!;

describe('Quantidades', () => {
  it('inteiros e decimais com vírgula ou ponto', () => {
    expect(q('2')).toBe(2); expect(q('0,5')).toBe(0.5); expect(q('1,5')).toBe(1.5); expect(q('0.25')).toBe(0.25);
  });
  it('frações com barra e mistas', () => {
    expect(q('1/2')).toBe(0.5); expect(q('3/4')).toBe(0.75); expect(q('1 1/2')).toBe(1.5); expect(q('2 1/4')).toBe(2.25);
    expect(q('1/3')).toBeCloseTo(1 / 3, 10);
  });
  it('frações Unicode, isoladas e mistas', () => {
    expect(q('½')).toBe(0.5); expect(q('¼')).toBe(0.25); expect(q('¾')).toBe(0.75); expect(q('1 ½')).toBe(1.5); expect(q('2½')).toBe(2.5);
    expect(q('⅓')).toBeCloseTo(1 / 3, 10);
  });
  it('separador de milhar e decimais com zero à esquerda', () => {
    expect(q('1.000')).toBe(1000); expect(q('0.500')).toBe(0.5); expect(q('1.5')).toBe(1.5);
  });
  it('números por extenso comuns', () => {
    expect(q('meia xícara')).toBe(0.5); expect(q('uma xícara')).toBe(1); expect(q('Duas colheres')).toBe(2); expect(q('três ovos')).toBe(3);
  });
  it('intervalos usam o menor valor e avisam', () => {
    const r = parseQuantity('2 a 3 xícaras')!;
    expect(r.value).toBe(2); expect(r.note).toContain('menor valor');
    expect(q('2-3')).toBe(2);
  });
  it('sem quantidade → null; denominador zero não vira Infinity', () => {
    expect(parseQuantity('farinha')).toBeNull();
    expect(parseQuantity('1/0')?.value).toBe(1);
  });
});

describe('Unidades', () => {
  const cases: [string, string, number][] = [
    ['1 xícara de açúcar', 'xic', 1], ['1 xícara (chá) de açúcar', 'xic', 1], ['2 xícaras (chá) de farinha', 'xic', 2], ['1 xic. de leite', 'xic', 1],
    ['1 xicara de cha de agua', 'xic', 1], ['1 colher (sopa) de óleo', 'cs', 1], ['2 colheres de sopa de óleo', 'cs', 2], ['1 colher de chá de sal', 'cc', 1],
    ['1 colher (chá) de canela', 'cc', 1], ['1 csp de fermento', 'cs', 1], ['2 cch de sal', 'cc', 2], ['200 g de manteiga', 'g', 200], ['200g de manteiga', 'g', 200],
    ['300 gramas de açúcar', 'g', 300], ['1 kg de farinha', 'kg', 1], ['1,5kg de farinha', 'kg', 1.5], ['500 ml de leite', 'ml', 500], ['500mL de leite', 'ml', 500],
    ['1 L de leite', 'l', 1], ['2 litros de água', 'l', 2], ['2 ovos', 'un', 2], ['3 unidades de banana', 'un', 3],
  ];
  it.each(cases)('%s → %s', (text, unit, qty) => {
    const p = line(text);
    expect(p.unit).toBe(unit); expect(p.quantity).toBe(qty); expect(p.unitLabel).toBeUndefined();
  });
  it('"g" não confunde com palavras que começam com g', () => {
    expect(line('2 gemas').unit).toBe('un'); expect(line('2 gemas').name).toBe('gemas');
    expect(line('1 limão').unit).toBe('un'); expect(line('1 limão').name).toBe('limão');
  });
  it('"colher" sem sopa/chá é ambígua e não é adivinhada', () => {
    const p = line('1 colher de manteiga');
    expect(p.unit).toBeUndefined(); expect(p.unitLabel).toBe('colher'); expect(p.name).toBe('manteiga');
  });
  it('colher de café/sobremesa e xícara de café não são suportadas', () => {
    expect(line('1 colher de café de sal').unit).toBeUndefined();
    expect(line('1 colher de café de sal').unitLabel).toContain('café');
    expect(line('1 xícara (café) de açúcar').unit).toBeUndefined();
  });
  it('medidas de embalagem ficam sinalizadas, sem equivalência inventada', () => {
    const p = line('1 lata de leite condensado');
    expect(p.unit).toBeUndefined(); expect(p.unitLabel).toBe('lata'); expect(p.name).toBe('leite condensado');
    expect(line('3 dentes de alho').unitLabel).toBe('dentes');
    expect(line('1 pitada de sal').unitLabel).toBe('pitada');
  });
  it('"ovos de codorna" mantém o nome completo', () => expect(line('12 ovos de codorna').name).toBe('ovos de codorna'));
});

describe('Linhas completas', () => {
  it('exemplo da especificação', () => {
    const rows = parseIngredientList(`2 ovos
1 xícara (chá) de açúcar
½ xícara (chá) de leite
2 xícaras (chá) de farinha de trigo
1 colher (sopa) de fermento químico
Óleo para fritar`);
    expect(rows.map(r => [r.name, r.quantity, r.unit])).toEqual([
      ['ovos', 2, 'un'], ['açúcar', 1, 'xic'], ['leite', 0.5, 'xic'], ['farinha de trigo', 2, 'xic'], ['fermento químico', 1, 'cs'], ['Óleo', undefined, undefined],
    ]);
    expect(rows[5].indefinite).toBe(true);
  });
  it('quantidades indefinidas: a gosto, quanto baste, q.b., para fritar, sem número', () => {
    for (const t of ['Sal a gosto', 'Sal q.b.', 'Sal quanto baste', 'sal QB', 'Óleo para fritar', 'Óleo suficiente para fritar', 'Um pouco de sal', 'Açúcar de confeiteiro para polvilhar', 'Sal']) {
      const p = line(t); expect(p.indefinite, t).toBe(true); expect(p.quantity, t).toBeUndefined(); expect(p.notes.length, t).toBeGreaterThan(0);
    }
    expect(line('Sal a gosto').name).toBe('Sal');
    expect(line('Um pouco de sal').name).toBe('sal');
    expect(line('Açúcar de confeiteiro para polvilhar').name).toBe('Açúcar de confeiteiro');
  });
  it('observações após vírgula ou parênteses não entram no nome', () => {
    expect(line('1 cebola, picada').name).toBe('cebola');
    expect(line('2 xícaras de farinha de trigo (peneirada)').name).toBe('farinha de trigo');
    expect(line('200 g de manteiga - sem sal').name).toBe('manteiga');
  });
  it('ignora marcadores de lista, linhas vazias e títulos de seção', () => {
    const rows = parseIngredientList('Massa:\n\n- 2 ovos\n• 1 xícara de açúcar\n* 200 g de manteiga\n  \n');
    expect(rows.map(r => r.name)).toEqual(['ovos', 'açúcar', 'manteiga']);
  });
  it('aceita quebras de linha do Windows e acentos preservados', () => {
    const rows = parseIngredientList('2 ovos\r\n1 colher (chá) de essência de baunilha');
    expect(rows).toHaveLength(2); expect(rows[1].name).toBe('essência de baunilha');
  });
  it('texto sem nenhuma linha útil → lista vazia', () => expect(parseIngredientList('   \n\n')).toEqual([]));
});
