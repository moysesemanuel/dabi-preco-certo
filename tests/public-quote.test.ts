import { describe, expect, it } from 'vitest';
import { computeTotals, formatCents, formatDate, formatQuantity, isValidIsoDate, LIMITS, normalizePhone, validatePublicQuote, whatsappContactUrl, type PublicQuote } from '../shared/publicQuote';

const valid = (): PublicQuote => ({
  version: 1, quoteNumber: '001', businessName: 'Doces da Bia', businessPhone: '5541999990000', issuedAt: '2026-11-11', validUntil: '2026-11-15',
  items: [{ description: 'Bolo de chocolate', quantity: 2, unitPriceCents: 6500 }], deliveryFeeCents: 1500, notes: 'Reserva sujeita à confirmação',
});
const check = (mutate: (q: Record<string, unknown>) => void) => { const q = valid() as unknown as Record<string, unknown>; mutate(q); return validatePublicQuote(q); };
const code = (r: ReturnType<typeof validatePublicQuote>) => (r.ok ? 'OK' : r.error);

describe('Validação do orçamento público', () => {
  it('aceita um orçamento válido e devolve uma cópia normalizada', () => {
    const r = validatePublicQuote(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote).toEqual(valid());
  });
  it('preserva acentuação e caracteres especiais', () => {
    const r = check(q => { q.businessName = 'Confeitaria "São João" & Cia — ação'; (q.items as { description: string }[])[0].description = 'Brigadeiro gourmet 🍫 (ñ)'; });
    expect(r.ok && r.quote.businessName).toBe('Confeitaria "São João" & Cia — ação');
    expect(r.ok && r.quote.items[0].description).toBe('Brigadeiro gourmet 🍫 (ñ)');
  });
  it('rejeita entrada que não é objeto, vazia ou inválida', () => {
    for (const bad of [null, undefined, 'texto', 42, [], {}]) expect(validatePublicQuote(bad).ok).toBe(false);
    expect(code(validatePublicQuote({}))).toBe('UNSUPPORTED_VERSION');
  });
  it('rejeita versão desconhecida', () => {
    expect(code(check(q => { q.version = 2; }))).toBe('UNSUPPORTED_VERSION');
    expect(code(check(q => { delete q.version; }))).toBe('UNSUPPORTED_VERSION');
  });
  it('rejeita quantidade negativa, zero, excessiva ou com mais de 3 decimais', () => {
    for (const quantity of [-1, 0, NaN, Infinity, '2', LIMITS.maxQuantity + 1, 1.2345]) {
      expect(code(check(q => { (q.items as { quantity: unknown }[])[0].quantity = quantity; })), String(quantity)).toBe('INVALID_QUANTITY');
    }
    expect(check(q => { (q.items as { quantity: unknown }[])[0].quantity = 0.125; }).ok).toBe(true);
  });
  it('rejeita preço inválido (negativo, decimal, texto, excessivo)', () => {
    for (const price of [-1, 10.5, '65', NaN, null, LIMITS.maxPriceCents + 1]) {
      expect(code(check(q => { (q.items as { unitPriceCents: unknown }[])[0].unitPriceCents = price; })), String(price)).toBe('INVALID_PRICE');
    }
    expect(code(check(q => { q.deliveryFeeCents = -5; }))).toBe('INVALID_PRICE');
    expect(code(check(q => { q.discountCents = 1.5; }))).toBe('INVALID_PRICE');
  });
  it('aceita valor agregado acima do preço unitário quando a linha representa uma encomenda inteira', () => {
    const r = check(q => { (q.items as { quantity: number; unitPriceCents: number }[])[0].quantity = 1; (q.items as { unitPriceCents: number }[])[0].unitPriceCents = LIMITS.maxPriceCents + 1; });
    expect(r.ok).toBe(true);
  });
  it('rejeita textos longos demais ou com caracteres de controle', () => {
    expect(code(check(q => { q.businessName = 'x'.repeat(LIMITS.businessName + 1); }))).toBe('TOO_LONG');
    expect(code(check(q => { q.quoteNumber = 'x'.repeat(LIMITS.quoteNumber + 1); }))).toBe('TOO_LONG');
    expect(code(check(q => { (q.items as { description: string }[])[0].description = 'x'.repeat(LIMITS.description + 1); }))).toBe('TOO_LONG');
    expect(code(check(q => { q.notes = 'x'.repeat(LIMITS.notes + 1); }))).toBe('TOO_LONG');
    expect(code(check(q => { q.businessName = 'Loja\u0000'; }))).toBe('INVALID_TEXT');
    expect(code(check(q => { q.businessName = 'Loja‮oirt'; }))).toBe('INVALID_TEXT'); // sobreposição bidirecional
  });
  it('em campos de uma linha, quebras e espaços repetidos viram um espaço', () => {
    const r = check(q => { (q.items as { description: string }[])[0].description = '  Bolo\n  de   cenoura\t'; });
    expect(r.ok && r.quote.items[0].description).toBe('Bolo de cenoura');
  });
  it('conta o limite em caracteres, não em bytes', () => {
    expect(check(q => { q.businessName = '😀'.repeat(LIMITS.businessName); }).ok).toBe(true);
  });
  it('aceita quebra de linha só nas observações', () => {
    const r = check(q => { q.notes = 'Linha 1\r\nLinha 2'; });
    expect(r.ok && r.quote.notes).toBe('Linha 1\nLinha 2');
  });
  it('rejeita número excessivo de itens e lista vazia', () => {
    const item = { description: 'Doce', quantity: 1, unitPriceCents: 100 };
    expect(code(check(q => { q.items = Array.from({ length: LIMITS.maxItems + 1 }, () => item); }))).toBe('TOO_MANY_ITEMS');
    expect(check(q => { q.items = Array.from({ length: LIMITS.maxItems }, () => item); }).ok).toBe(true);
    expect(code(check(q => { q.items = []; }))).toBe('EMPTY_ITEMS');
  });
  it('valida datas reais e a ordem entre emissão e validade', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    for (const d of ['2026-02-31', '2026-13-01', '11/11/2026', '2026-1-1', '1999-01-01', '', 5]) expect(isValidIsoDate(d), String(d)).toBe(false);
    expect(code(check(q => { q.issuedAt = '2026-02-31'; }))).toBe('INVALID_DATE');
    expect(code(check(q => { q.validUntil = '2026-11-10'; }))).toBe('INVALID_DATE');
  });
  it('valida o telefone comercial (somente dígitos)', () => {
    for (const phone of ['41999990000x', '(41) 99999-0000', '123', '1'.repeat(16), 5541999990000]) expect(code(check(q => { q.businessPhone = phone; })), String(phone)).toBe('INVALID_PHONE');
  });
  it('normalizePhone ajuda o app: extrai dígitos e assume DDI 55', () => {
    expect(normalizePhone('(41) 99999-0000')).toBe('5541999990000');
    expect(normalizePhone('+55 41 99999-0000')).toBe('5541999990000');
    expect(normalizePhone('abc')).toBeUndefined();
  });
  it('rejeita campos desconhecidos: nenhum dado interno pode "carona" no orçamento', () => {
    for (const key of ['total', 'cost', 'margin', 'purchasePrice', 'customer', 'ingredients', 'owner_id', 'token']) {
      const r = check(q => { q[key] = 1; });
      expect(r.ok, key).toBe(false);
      if (!r.ok) { expect(r.error).toBe('UNKNOWN_FIELD'); expect(r.field).toBe(key); }
    }
    expect(code(check(q => { (q.items as Record<string, unknown>[])[0].costCents = 100; }))).toBe('UNKNOWN_FIELD');
    expect(code(check(q => { (q.items as Record<string, unknown>[])[0].margin = 30; }))).toBe('UNKNOWN_FIELD');
  });
  it('rejeita desconto maior que o total e total acima do limite', () => {
    expect(code(check(q => { q.discountCents = 14501; }))).toBe('DISCOUNT_EXCEEDS_TOTAL'); // 130,00 + 15,00 = 145,00
    expect(check(q => { q.discountCents = 14500; }).ok).toBe(true);
    expect(code(check(q => { q.items = Array.from({ length: 50 }, () => ({ description: 'Caro', quantity: 10_000, unitPriceCents: 10_000_000 })); }))).toBe('TOTAL_TOO_LARGE');
  });
});

describe('Totais (sempre calculados a partir dos valores públicos)', () => {
  it('subtotal, entrega, desconto e total', () => {
    const t = computeTotals(valid());
    expect(t.lines).toEqual([{ lineTotalCents: 13000 }]);
    expect(t).toMatchObject({ subtotalCents: 13000, deliveryFeeCents: 1500, discountCents: 0, totalCents: 14500 });
    const d = computeTotals({ ...valid(), discountCents: 2000 });
    expect(d.totalCents).toBe(12500);
  });
  it('quantidades fracionadas e arredondamento em centavos, sem erro de ponto flutuante', () => {
    const q: PublicQuote = { ...valid(), deliveryFeeCents: undefined, items: [{ description: 'Brigadeiro', quantity: 0.5, unitPriceCents: 1999 }, { description: 'Torta', quantity: 3, unitPriceCents: 3333 }] };
    const t = computeTotals(q);
    expect(t.lines.map(l => l.lineTotalCents)).toEqual([1000, 9999]); // 999,5 → 1000
    expect(t.totalCents).toBe(10999);
    // o arredondamento é por linha: 0,3 → 0 e 0,6 → 1
    expect(computeTotals({ ...valid(), items: [{ description: 'x', quantity: 0.1, unitPriceCents: 3 }, { description: 'y', quantity: 0.2, unitPriceCents: 3 }] }).subtotalCents).toBe(1);
  });
  it('um campo "total" enviado de fora nunca é usado', () => {
    const forged = { ...valid(), total: 1 } as unknown;
    expect(validatePublicQuote(forged).ok).toBe(false);
  });
});

describe('Formatação pt-BR e WhatsApp', () => {
  it('formata moeda, quantidade e data', () => {
    expect(formatCents(6500)).toBe('R$ 65,00'); expect(formatCents(123456)).toBe('R$ 1.234,56'); expect(formatCents(0)).toBe('R$ 0,00');
    expect(formatQuantity(2)).toBe('2'); expect(formatQuantity(0.5)).toBe('0,5');
    expect(formatDate('2026-11-11')).toBe('11/11/2026');
  });
  it('link de WhatsApp só existe com telefone válido e codifica a mensagem', () => {
    const url = whatsappContactUrl(valid())!;
    expect(url.startsWith('https://wa.me/5541999990000?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toBe('Olá! Sobre o orçamento nº 001 da Doces da Bia.');
    expect(whatsappContactUrl({ ...valid(), businessPhone: undefined })).toBeUndefined();
    expect(whatsappContactUrl({ ...valid(), businessPhone: '123' })).toBeUndefined();
    expect(whatsappContactUrl({ ...valid(), businessName: 'A&B #1' })!).not.toContain('A&B');
  });
});
