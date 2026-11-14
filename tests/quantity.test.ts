import { describe, expect, it } from 'vitest';
import { parseQuantity } from '../src/domain/quantity';

describe('parseQuantity', () => {
  it('inteiros e decimais com vírgula ou ponto', () => {
    expect(parseQuantity('2')).toBe(2); expect(parseQuantity('2,5')).toBe(2.5); expect(parseQuantity('2.5')).toBe(2.5); expect(parseQuantity(',5')).toBe(0.5); expect(parseQuantity(' 0 ')).toBe(0);
  });
  it('frações e números mistos', () => {
    expect(parseQuantity('1/2')).toBe(0.5); expect(parseQuantity('3 / 4')).toBe(0.75); expect(parseQuantity('1 1/2')).toBe(1.5); expect(parseQuantity('2 1/4')).toBe(2.25);
    expect(parseQuantity('1/3')).toBeCloseTo(0.3333333, 6);
  });
  it('frações unicode', () => {
    expect(parseQuantity('½')).toBe(0.5); expect(parseQuantity('1½')).toBe(1.5); expect(parseQuantity('1 ¾')).toBe(1.75); expect(parseQuantity('⅓')).toBeCloseTo(1 / 3, 9);
  });
  it('recusa o que não é quantidade (nunca adivinha)', () => {
    for (const t of ['', '   ', 'abc', '1/0', '-1', '1,2,3', '1/', '/2', '1,5½', '1.000,5', '1e3', '--', '1 1/0', 'Infinity', '2x'])  expect(parseQuantity(t), t).toBeUndefined();
  });
});
