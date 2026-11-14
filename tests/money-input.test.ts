import { describe, expect, it } from 'vitest';
import { parseMoneyInput } from '../src/domain/money';

describe('parseMoneyInput', () => {
  it('distingue campo vazio de zero real', () => {
    expect(parseMoneyInput('')).toBeUndefined();
    expect(parseMoneyInput('   ')).toBeUndefined();
    expect(parseMoneyInput('R$ 0,00')).toBe(0);
  });

  it.each([
    ['25,90', 25.9],
    ['25.90', 25.9],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['R$ 1.234,56', 1234.56],
    ['-3,50', -3.5],
  ])('interpreta %s sem alterar o valor', (input, expected) => {
    expect(parseMoneyInput(input)).toBe(expected);
  });

  it('não aceita texto ou separadores malformados', () => {
    expect(Number.isNaN(parseMoneyInput('abc'))).toBe(true);
    expect(Number.isNaN(parseMoneyInput('1,2,3'))).toBe(true);
    expect(Number.isNaN(parseMoneyInput('R$ --2'))).toBe(true);
  });
});
