import { describe, expect, it } from 'vitest';
import { effectiveQuoteCodes, generateQuoteCode, isQuoteCode, legacyQuoteCode, normalizeCodeQuery, QUOTE_CODE_ALPHABET, uniqueQuoteCode, withQuoteCodes } from '../shared/quoteCode';
import { validateDataSet } from '../shared/dataset';
import { validateBackup } from '../src/storage/db';

const order = (id: string, createdAt = '2026-11-01T10:00:00.000Z', quoteCode?: string) => ({ id, createdAt, ...(quoteCode ? { quoteCode } : {}) });

describe('Formato e geração', () => {
  it('ORC- + 6 caracteres legíveis, sem símbolos ambíguos (0, 1, I, L, O, U)', () => {
    for (let n = 0; n < 500; n++) { const c = generateQuoteCode(); expect(c).toMatch(/^ORC-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/); expect(isQuoteCode(c)).toBe(true); }
    for (const bad of '01ILOU') expect(QUOTE_CODE_ALPHABET).not.toContain(bad);
    expect(QUOTE_CODE_ALPHABET).toHaveLength(30);
  });
  it('é aleatório, sem viés e sem sequência (distribuição uniforme, 20 mil códigos distintos)', () => {
    const seen = new Set<string>(), freq = new Map<string, number>();
    for (let n = 0; n < 20_000; n++) { const c = generateQuoteCode(); seen.add(c); for (const ch of c.slice(4)) freq.set(ch, (freq.get(ch) ?? 0) + 1); }
    expect(seen.size).toBeGreaterThan(19_990);
    const counts = [...freq.values()], mean = (20_000 * 6) / 30;
    expect(freq.size).toBe(30); for (const c of counts) expect(Math.abs(c - mean) / mean).toBeLessThan(0.08);
  });
  it('descarta bytes que causariam viés e usa a fonte de números aleatórios injetada', () => {
    const seq = [250, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; let i = 0;
    const code = generateQuoteCode(n => Uint8Array.from({ length: n }, () => seq[i++ % seq.length]));
    expect(code).toBe('ORC-' + [0, 1, 2, 3, 4, 5].map(b => QUOTE_CODE_ALPHABET[b]).join('')); // 250 e 255 foram descartados
  });
  it('uniqueQuoteCode evita os códigos já usados e os reserva', () => {
    const used = new Set<string>(); const fixed = () => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const first = uniqueQuoteCode(used, fixed); expect(used.has(first)).toBe(true);
    expect(() => uniqueQuoteCode(used, fixed)).toThrow(/único/); // gerador "preso": falha em vez de repetir
    expect(uniqueQuoteCode(used)).not.toBe(first);
  });
});

describe('Pedidos existentes (código derivado, determinístico)', () => {
  it('o mesmo id gera o mesmo código em qualquer aparelho; ids diferentes, códigos diferentes; não contém o id', () => {
    const id = '7f3a9c2e-1111-4222-8333-444455556666';
    expect(legacyQuoteCode(id)).toBe(legacyQuoteCode(id)); expect(isQuoteCode(legacyQuoteCode(id))).toBe(true);
    expect(legacyQuoteCode(id)).not.toBe(legacyQuoteCode(id.replace('7f', '8f')));
    expect(legacyQuoteCode(id).toLowerCase()).not.toContain(id.slice(0, 6));
  });
  it('colisões entre códigos derivados são desempatadas sempre do mesmo jeito, qualquer que seja a ordem da lista', () => {
    const a = order('a'), b = order('b', '2026-11-02T10:00:00.000Z');
    const forced = effectiveQuoteCodes([a, b]); // base
    // força colisão: b já tem o código derivado de a
    const clash = [order('b', '2026-11-02T10:00:00.000Z', forced.get('a')!), a];
    const r1 = effectiveQuoteCodes(clash), r2 = effectiveQuoteCodes([...clash].reverse());
    expect(r1.get('a')).not.toBe(forced.get('a')); expect([...r1.entries()].sort()).toEqual([...r2.entries()].sort());
    expect(new Set(r1.values()).size).toBe(2);
  });
  it('withQuoteCodes só acrescenta o código: nada financeiro muda, e é idempotente', () => {
    const o = { ...order('x'), customer: 'Ana', quantity: 2, unitPrice: 50, deposit: 10, payments: [{ id: 'p', amount: 20, receivedAt: '2026-11-02' }], costSnapshot: { costPerUnit: 3, capturedAt: '2026-11-01T10:00:00.000Z' } };
    const [out] = withQuoteCodes([o]); const { quoteCode, ...rest } = out;
    expect(isQuoteCode(quoteCode)).toBe(true); expect(rest).toEqual(o);
    expect(withQuoteCodes([out])[0]).toBe(out); const list = [out]; expect(withQuoteCodes(list)).toBe(list);
  });
  it('um pedido que já tem código nunca é alterado', () => {
    expect(withQuoteCodes([order('x', undefined, 'ORC-K7M42P')])[0].quoteCode).toBe('ORC-K7M42P');
  });
});

describe('Digitar o código na busca', () => {
  it('aceita com ou sem ORC, com ou sem hífen, em qualquer caixa', () => {
    for (const q of ['ORC-K7M42P', 'orc-k7m42p', 'ORCK7M42P', 'k7m42p', ' K7M-42P ', 'Orc K7M42P']) expect(normalizeCodeQuery(q), q).toBe('k7m42p'.toUpperCase());
  });
});

describe('Backup e restauração', () => {
  const ds = (orders: Record<string, unknown>[]) => ({ schemaVersion: 3, ingredients: [], recipes: [{ id: 'r', name: 'Bolo', yield: 1, items: [], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 0 }], orders: orders.map(o => ({ customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-11T10:00:00.000Z', ...o })) });
  it('o código sobrevive a exportar → restaurar', () => {
    const out = validateDataSet(JSON.parse(JSON.stringify(ds([{ id: 'o1', quoteCode: 'ORC-K7M42P' }, { id: 'o2', quoteCode: 'ORC-ABCDEF' }]))));
    expect(out.orders.map(o => o.quoteCode)).toEqual(['ORC-K7M42P', 'ORC-ABCDEF']);
  });
  it('backup antigo (sem códigos) é restaurado e os pedidos recebem o código derivado, sem alterar mais nada', () => {
    const raw = ds([{ id: 'o1', deposit: 5, payments: [{ id: 'p1', amount: 5, receivedAt: '2026-11-12' }] }]);
    const out = validateBackup(raw);
    expect(isQuoteCode(out.orders[0].quoteCode)).toBe(true); expect(out.orders[0].quoteCode).toBe(legacyQuoteCode('o1'));
    const { quoteCode, ...rest } = out.orders[0]; expect(rest).toEqual(validateDataSet(raw).orders[0]);
  });
  it('código malformado ou repetido é recusado (dados externos não são confiáveis)', () => {
    expect(() => validateDataSet(ds([{ id: 'o1', quoteCode: 'ORC-0O1ILU' }]))).toThrow(/código do orçamento inválido/);
    expect(() => validateDataSet(ds([{ id: 'o1', quoteCode: 'k7m42p' }]))).toThrow(/código do orçamento inválido/);
    expect(() => validateDataSet(ds([{ id: 'o1', quoteCode: 'ORC-K7M42P' }, { id: 'o2', quoteCode: 'ORC-K7M42P' }]))).toThrow(/repetido/);
  });
});
