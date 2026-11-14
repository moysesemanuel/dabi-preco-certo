/**
 * Contrato público de um orçamento compartilhado. É independente dos modelos internos do app:
 * só contém o que o cliente final pode ver. Nunca inclua custos, margens, preços de compra,
 * dados do cliente ou qualquer registro do IndexedDB. Dinheiro em centavos inteiros.
 *
 * Usado pelo Worker (validação na publicação e na leitura) e, futuramente, pelo app (montagem do orçamento).
 * Sem dependências; funções puras.
 */
export type PublicQuoteItem = { description: string; quantity: number; unitPriceCents: number };
export type PublicQuote = {
  version: 1;
  quoteNumber: string;
  businessName: string;
  /** Somente dígitos com DDI/DDD, ex.: 5541999990000. */
  businessPhone?: string;
  /** AAAA-MM-DD */
  issuedAt: string;
  validUntil?: string;
  items: PublicQuoteItem[];
  deliveryFeeCents?: number;
  discountCents?: number;
  notes?: string;
};

export const LIMITS = {
  maxItems: 50,
  quoteNumber: 20,
  businessName: 80,
  description: 120,
  notes: 1000,
  maxQuantity: 10_000,
  maxPriceCents: 10_000_000, // R$ 100.000,00 por unidade/taxa/desconto; encomenda agregada é limitada por maxTotalCents
  maxTotalCents: 1_000_000_000, // R$ 10.000.000,00 por orçamento
  /** Tamanho máximo do corpo JSON aceito na publicação. */
  maxBodyBytes: 16_384,
} as const;

export type ValidationErrorCode =
  | 'INVALID_TYPE' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'TOO_LONG' | 'INVALID_TEXT'
  | 'INVALID_DATE' | 'INVALID_PHONE' | 'INVALID_QUANTITY' | 'INVALID_PRICE' | 'EMPTY_ITEMS' | 'TOO_MANY_ITEMS'
  | 'DISCOUNT_EXCEEDS_TOTAL' | 'TOTAL_TOO_LARGE';
export type ValidationResult = { ok: true; quote: PublicQuote } | { ok: false; error: ValidationErrorCode; field: string };

const TOP_KEYS = new Set(['version', 'quoteNumber', 'businessName', 'businessPhone', 'issuedAt', 'validUntil', 'items', 'deliveryFeeCents', 'discountCents', 'notes']);
const ITEM_KEYS = new Set(['description', 'quantity', 'unitPriceCents']);
// Controle (exceto \n e \t), separadores de linha/parágrafo e sobreposições bidirecionais (usadas para disfarçar texto).
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: ValidationErrorCode, field: string): ValidationResult => ({ ok: false, error, field });
const codePoints = (s: string) => Array.from(s).length;

type Cleaned = { ok: true; value: string } | { ok: false; error: ValidationErrorCode };
function cleanText(value: unknown, max: number, multiline: boolean): Cleaned {
  if (typeof value !== 'string') return { ok: false, error: 'INVALID_TYPE' };
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!multiline) text = text.replace(/\s+/g, ' ');
  if (FORBIDDEN_CHARS.test(text)) return { ok: false, error: 'INVALID_TEXT' };
  if (codePoints(text) > max) return { ok: false, error: 'TOO_LONG' };
  return { ok: true, value: text };
}

/** Data real no formato AAAA-MM-DD (rejeita 2026-02-31 e anos fora de 2000–2100). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const isValidPhone = (value: unknown): value is string => typeof value === 'string' && /^\d{10,15}$/.test(value);

/** Para o app: extrai dígitos e assume DDI 55 quando vier só DDD + número (10 ou 11 dígitos). Devolve undefined se inválido. */
export function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '');
  const withCountry = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  return isValidPhone(withCountry) ? withCountry : undefined;
}

const isCents = (v: unknown, max: number = LIMITS.maxPriceCents): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const quantityMilli = (q: number) => Math.round(q * 1000);
const isQuantity = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= LIMITS.maxQuantity && Math.abs(v * 1000 - quantityMilli(v)) < 1e-6;

/** Valida dados não confiáveis (publicação ou leitura do banco). Rejeita campos desconhecidos e devolve uma cópia normalizada. */
export function validatePublicQuote(input: unknown): ValidationResult {
  if (!isRecord(input)) return fail('INVALID_TYPE', 'quote');
  for (const key of Object.keys(input)) if (!TOP_KEYS.has(key)) return fail('UNKNOWN_FIELD', key);
  if (input.version !== 1) return fail('UNSUPPORTED_VERSION', 'version');

  const quoteNumber = cleanText(input.quoteNumber, LIMITS.quoteNumber, false);
  if (!quoteNumber.ok || !quoteNumber.value) return fail(quoteNumber.ok ? 'MISSING_FIELD' : quoteNumber.error, 'quoteNumber');
  const businessName = cleanText(input.businessName, LIMITS.businessName, false);
  if (!businessName.ok || !businessName.value) return fail(businessName.ok ? 'MISSING_FIELD' : businessName.error, 'businessName');

  if (!isValidIsoDate(input.issuedAt)) return fail('INVALID_DATE', 'issuedAt');
  if (input.validUntil !== undefined && (!isValidIsoDate(input.validUntil) || input.validUntil < input.issuedAt)) return fail('INVALID_DATE', 'validUntil');
  if (input.businessPhone !== undefined && !isValidPhone(input.businessPhone)) return fail('INVALID_PHONE', 'businessPhone');

  if (!Array.isArray(input.items) || input.items.length === 0) return fail('EMPTY_ITEMS', 'items');
  if (input.items.length > LIMITS.maxItems) return fail('TOO_MANY_ITEMS', 'items');
  const items: PublicQuoteItem[] = [];
  for (let i = 0; i < input.items.length; i++) {
    const raw: unknown = input.items[i];
    const at = `items[${i}]`;
    if (!isRecord(raw)) return fail('INVALID_TYPE', at);
    for (const key of Object.keys(raw)) if (!ITEM_KEYS.has(key)) return fail('UNKNOWN_FIELD', `${at}.${key}`);
    const description = cleanText(raw.description, LIMITS.description, false);
    if (!description.ok || !description.value) return fail(description.ok ? 'MISSING_FIELD' : description.error, `${at}.description`);
    if (!isQuantity(raw.quantity)) return fail('INVALID_QUANTITY', `${at}.quantity`);
    const maxItemPrice = raw.quantity === 1 ? LIMITS.maxTotalCents : LIMITS.maxPriceCents;
    if (!isCents(raw.unitPriceCents, maxItemPrice)) return fail('INVALID_PRICE', `${at}.unitPriceCents`);
    items.push({ description: description.value, quantity: raw.quantity, unitPriceCents: raw.unitPriceCents });
  }
  if (input.deliveryFeeCents !== undefined && !isCents(input.deliveryFeeCents)) return fail('INVALID_PRICE', 'deliveryFeeCents');
  if (input.discountCents !== undefined && !isCents(input.discountCents)) return fail('INVALID_PRICE', 'discountCents');

  let notes: string | undefined;
  if (input.notes !== undefined) {
    const n = cleanText(input.notes, LIMITS.notes, true);
    if (!n.ok) return fail(n.error, 'notes');
    notes = n.value || undefined;
  }

  const quote: PublicQuote = {
    version: 1, quoteNumber: quoteNumber.value, businessName: businessName.value, issuedAt: input.issuedAt, items,
    ...(input.businessPhone !== undefined ? { businessPhone: input.businessPhone } : {}),
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    ...(input.deliveryFeeCents !== undefined ? { deliveryFeeCents: input.deliveryFeeCents } : {}),
    ...(input.discountCents !== undefined ? { discountCents: input.discountCents } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  const totals = computeTotals(quote);
  if (totals.grossCents > LIMITS.maxTotalCents) return fail('TOTAL_TOO_LARGE', 'items');
  if (totals.discountCents > totals.grossCents) return fail('DISCOUNT_EXCEEDS_TOTAL', 'discountCents');
  return { ok: true, quote };
}

export type QuoteTotals = {
  lines: { lineTotalCents: number }[];
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  /** subtotal + entrega, antes do desconto. */
  grossCents: number;
  totalCents: number;
};

/** Sempre calculado a partir dos valores públicos; nunca confie em um total vindo de fora. Aritmética em inteiros. */
export function computeTotals(quote: PublicQuote): QuoteTotals {
  const lines = quote.items.map(i => ({ lineTotalCents: Math.round((quantityMilli(i.quantity) * i.unitPriceCents) / 1000) }));
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const deliveryFeeCents = quote.deliveryFeeCents ?? 0;
  const discountCents = quote.discountCents ?? 0;
  const grossCents = subtotalCents + deliveryFeeCents;
  return { lines, subtotalCents, deliveryFeeCents, discountCents, grossCents, totalCents: grossCents - discountCents };
}

// ---- Apresentação (pt-BR) ----
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatCents = (cents: number): string => brl.format(cents / 100).replace(/ /g, ' ');
export const formatQuantity = (q: number): string => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(q);
export const formatDate = (iso: string): string => iso.split('-').reverse().join('/');

/**
 * Oculta a linha de embalagem de orçamentos publicados antes da cobrança agregada.
 * Mantém exatamente o subtotal público, representando os itens como um valor fechado da encomenda.
 */
export function collapsePackagingBreakdown(quote: PublicQuote): PublicQuote {
  if (!quote.items.some(item => item.description === 'Embalagens adicionais')) return quote;
  const productDescription = quote.items
    .filter(item => item.description !== 'Embalagens adicionais')
    .map(item => item.quantity === 1 ? item.description : `${formatQuantity(item.quantity)} × ${item.description}`)
    .join('; ');
  const description = Array.from(productDescription || 'Encomenda').slice(0, LIMITS.description).join('');
  return {
    ...quote,
    items: [{ description, quantity: 1, unitPriceCents: computeTotals(quote).subtotalCents }],
  };
}

/** Link de WhatsApp para falar com o vendedor. Só existe quando o telefone é válido. */
export function whatsappContactUrl(quote: PublicQuote): string | undefined {
  if (!quote.businessPhone || !isValidPhone(quote.businessPhone)) return undefined;
  const text = `Olá! Sobre o orçamento nº ${quote.quoteNumber} da ${quote.businessName}.`;
  return `https://wa.me/${quote.businessPhone}?text=${encodeURIComponent(text)}`;
}
