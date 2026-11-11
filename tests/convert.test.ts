import { describe, expect, it } from 'vitest';
import { convert, conversionErrorMessage, type ConversionInput } from '../src/features/measurement/convert';
import { findReference, gramsPerCupToDensity, densityToGramsPerCup } from '../src/features/measurement/densities';
import { formatQuantity, friendlyAmount } from '../src/features/measurement/units';

const FARINHA = 120 / 240; // 120 g por xícara de 240 mL
const ACUCAR = 200 / 240;
const ok = (i: ConversionInput) => { const r = convert(i); if (!r.success) throw new Error(`falhou: ${r.error}`); return r; };

describe('Motor de conversão', () => {
  it('1 kg → 1.000 g', () => expect(ok({ quantity: 1, from: 'kg', to: 'g' }).value).toBe(1000));
  it('500 g → 0,5 kg', () => expect(ok({ quantity: 500, from: 'g', to: 'kg' }).value).toBe(0.5));
  it('1 L → 1.000 mL', () => expect(ok({ quantity: 1, from: 'l', to: 'ml' }).value).toBe(1000));
  it('2 xícaras de 240 mL → 480 mL', () => expect(ok({ quantity: 2, from: 'xic', to: 'ml' }).value).toBe(480));
  it('1 colher de sopa → 15 mL e 1 colher de chá → 5 mL', () => {
    expect(ok({ quantity: 1, from: 'cs', to: 'ml' }).value).toBe(15);
    expect(ok({ quantity: 1, from: 'cc', to: 'ml' }).value).toBe(5);
  });
  it('2 xícaras de farinha → 240 g (120 g/xícara)', () => expect(ok({ quantity: 2, from: 'xic', to: 'g', densityGPerMl: FARINHA }).value).toBeCloseTo(240, 9));
  it('1 xícara de açúcar → 200 g', () => expect(ok({ quantity: 1, from: 'xic', to: 'g', densityGPerMl: ACUCAR }).value).toBeCloseTo(200, 9));
  it('240 g de farinha → 2 xícaras', () => expect(ok({ quantity: 240, from: 'g', to: 'xic', densityGPerMl: FARINHA }).value).toBeCloseTo(2, 9));
  it('massa ↔ volume sem densidade → erro controlado', () => {
    expect(convert({ quantity: 1, from: 'xic', to: 'g' })).toEqual({ success: false, error: 'MISSING_DENSITY' });
    expect(convert({ quantity: 100, from: 'g', to: 'ml' })).toEqual({ success: false, error: 'MISSING_DENSITY' });
  });
  it('unidade ↔ grama sem equivalência → erro controlado', () => {
    expect(convert({ quantity: 1, from: 'un', to: 'g' })).toEqual({ success: false, error: 'MISSING_UNIT_EQUIVALENCE' });
    expect(convert({ quantity: 50, from: 'g', to: 'un' })).toEqual({ success: false, error: 'MISSING_UNIT_EQUIVALENCE' });
    expect(convert({ quantity: 1, from: 'un', to: 'ml' })).toEqual({ success: false, error: 'MISSING_UNIT_EQUIVALENCE' });
  });
  it('unidade ↔ peso/volume com equivalência cadastrada', () => {
    expect(ok({ quantity: 3, from: 'un', to: 'g', gramsPerUnit: 50 }).value).toBe(150);
    expect(ok({ quantity: 100, from: 'g', to: 'un', gramsPerUnit: 50 }).value).toBe(2);
    expect(ok({ quantity: 2, from: 'un', to: 'ml', mlPerUnit: 30 }).value).toBe(60);
  });
  it('quantidade negativa ou inválida → erro controlado (nunca NaN)', () => {
    for (const q of [-1, NaN, Infinity, -Infinity]) expect(convert({ quantity: q, from: 'g', to: 'kg' })).toEqual({ success: false, error: 'INVALID_QUANTITY' });
    expect(convert({ quantity: '2' as unknown as number, from: 'g', to: 'kg' }).success).toBe(false);
  });
  it('quantidade zero → resultado zero válido', () => expect(ok({ quantity: 0, from: 'kg', to: 'g' }).value).toBe(0));
  it('xícara de 200 mL e de 250 mL → conversão proporcional', () => {
    expect(ok({ quantity: 1, from: 'xic', to: 'ml', cupSizeMl: 200 }).value).toBe(200);
    expect(ok({ quantity: 1, from: 'xic', to: 'ml', cupSizeMl: 250 }).value).toBe(250);
    expect(ok({ quantity: 2, from: 'xic', to: 'g', cupSizeMl: 250, densityGPerMl: 0.5 }).value).toBe(250);
  });
  it('unidade → unidade preserva a quantidade', () => expect(ok({ quantity: 7.5, from: 'un', to: 'un' }).value).toBe(7.5));
  it('configuração inválida → erro controlado', () => {
    expect(convert({ quantity: 1, from: 'xic', to: 'ml', cupSizeMl: 0 })).toEqual({ success: false, error: 'INVALID_CONFIGURATION' });
    expect(convert({ quantity: 1, from: 'xic', to: 'g', densityGPerMl: -1 })).toEqual({ success: false, error: 'INVALID_CONFIGURATION' });
    expect(convert({ quantity: 1, from: 'xic', to: 'g', densityGPerMl: 0 })).toEqual({ success: false, error: 'INVALID_CONFIGURATION' });
  });
  it('indica quando o resultado é aproximado', () => {
    expect(ok({ quantity: 1, from: 'kg', to: 'g' }).approximate).toBe(false);
    expect(ok({ quantity: 1, from: 'l', to: 'ml' }).approximate).toBe(false);
    expect(ok({ quantity: 1, from: 'xic', to: 'g', densityGPerMl: FARINHA }).approximate).toBe(true);
    expect(ok({ quantity: 1, from: 'cs', to: 'ml' }).approximate).toBe(true);
  });
  it('não arredonda valores intermediários', () => expect(ok({ quantity: 1, from: 'ml', to: 'xic' }).value).toBeCloseTo(1 / 240, 12));
});

describe('Mensagens, referências e apresentação', () => {
  it('mensagens nomeiam a configuração que falta', () => {
    expect(conversionErrorMessage('MISSING_DENSITY', 'xic', 'g', 'Farinha')).toContain('Farinha');
    expect(conversionErrorMessage('MISSING_DENSITY', 'xic', 'g', 'Farinha')).toContain('xícara');
    expect(conversionErrorMessage('MISSING_UNIT_EQUIVALENCE', 'un', 'g', 'Ovo')).toContain('1 unidade');
  });
  it('referências só casam com o nome completo, sem adivinhar', () => {
    expect(findReference('farinha de trigo')?.gramsPerCup).toBe(120);
    expect(findReference('Açúcar Refinado')?.gramsPerCup).toBe(200);
    expect(findReference('Farinha de trigo integral')).toBeUndefined();
    expect(findReference('Leite condensado')).toBeUndefined();
    expect(findReference('Farinha de mandioca')).toBeUndefined();
    expect(findReference('')).toBeUndefined();
  });
  it('densidade ↔ gramas por xícara depende do tamanho da xícara', () => {
    expect(gramsPerCupToDensity(120, 240)).toBe(0.5);
    expect(densityToGramsPerCup(0.5, 250)).toBe(125);
  });
  it('arredonda só na apresentação', () => {
    expect(formatQuantity(240.00000000000003, 'g')).toBe('240');
    expect(formatQuantity(0.2400004, 'kg')).toBe('0,24');
    expect(formatQuantity(NaN, 'g')).toBe('—');
  });
  it('exibe valores menores que 1 kg/L em g/mL sem alterar o cálculo', () => {
    expect(friendlyAmount(0.24, 'kg')).toEqual({ value: 240, unit: 'g' });
    expect(friendlyAmount(0.5, 'l')).toEqual({ value: 500, unit: 'ml' });
    expect(friendlyAmount(2, 'kg')).toEqual({ value: 2, unit: 'kg' });
    expect(friendlyAmount(3, 'un')).toEqual({ value: 3, unit: 'un' });
  });
});
