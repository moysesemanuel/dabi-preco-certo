import { computeTotals, describeQuantity, formatCents, validatePublicQuote, type PublicIncludedItem, type PublicQuote, type PublicQuoteItem } from '../../../shared/publicQuote';
import { calculateOrderFinancials, itemSubtotal as subtotalOf } from '../../domain/orderFinancials';
const itemSubtotal = (quantity: number, unitPrice: number) => subtotalOf({ quantity, unitPrice });
import { itemName } from '../../domain/orders';
import { orderTotal } from '../../domain/payments';
import { legacyQuoteCode } from '../../../shared/quoteCode';
import { apiCall, field } from '../../account/http';
import type { Order, Recipe, Settings } from '../../domain/types';

/**
 * Monta o orçamento PÚBLICO a partir de uma encomenda. Inclui só o que o cliente pode ver:
 * produtos, quantidades, valores (veja `publicLines`), entrega, desconto, validade e observações.
 * Nunca inclui custo, embalagens discriminadas, margem, preço de compra, nome/telefone do cliente ou registros internos.
 */
export type QuoteOptions = { issuedAt: string; validUntil?: string; deliveryFee?: number; discount?: number; notes?: string };
export const toCents = (reais: number) => Math.round((reais + Number.EPSILON) * 100);
/** Número do orçamento = código permanente de atendimento do pedido (nunca o id interno nem o token do link). */
export const quoteNumberOf = (order: Pick<Order, 'id' | 'quoteCode'>) => order.quoteCode ?? legacyQuoteCode(order.id);

/** Linha consolidada do orçamento quando o valor dos produtos inclui embalagens adicionais. */
export const BUNDLED_LINE = 'Valor da encomenda';

/**
 * Como os produtos aparecem para o cliente (link público, prévia e texto copiado). Regra única:
 *  - sem embalagens adicionais cobradas: cada produto com quantidade, preço unitário e subtotal (a soma bate com o total);
 *  - com embalagens adicionais: os produtos aparecem só com a quantidade, e o valor é UM total consolidado. Assim o cliente
 *    nunca vê o valor da embalagem e nenhuma soma visível diverge do total (não há rateio nem arredondamento inventado).
 */
export function publicLines(order: Order, recipes: readonly Recipe[]): { priced: true; items: PublicQuoteItem[] } | { priced: false; included: PublicIncludedItem[]; totalCents: number } {
  const products = order.items.map(item => ({ description: itemName(item, recipes), quantity: item.quantity, unitPriceCents: toCents(item.unitPrice) }));
  const productsCents = toCents(calculateOrderFinancials({ items: order.items }).productsTotal);
  const priced = { version: 1 as const, quoteNumber: 'x', businessName: 'x', issuedAt: '2026-01-01', items: products };
  // Também consolida se o cálculo público por linha (inteiros) não reproduzir exatamente o subtotal (quantidades fracionárias).
  const exact = computeTotals(priced).subtotalCents === productsCents;
  if (!(order.packagingCharge && order.packagingCharge > 0) && exact) return { priced: true, items: products };
  return { priced: false, included: products.map(({ description, quantity }) => ({ description, quantity })), totalCents: toCents(orderTotal(order)) };
}

export function buildPublicQuote(order: Order, recipes: readonly Recipe[], settings: Settings | undefined, opts: QuoteOptions): { ok: true; quote: PublicQuote } | { ok: false; error: string } {
  if (!settings?.businessName) return { ok: false, error: 'Informe o nome do negócio em Configurações antes de gerar o orçamento.' };
  if (order.items.some(item => !item.recipeName && !recipes.some(r => r.id === item.recipeId))) return { ok: false, error: 'A receita desta encomenda não está mais disponível.' };
  const lines = publicLines(order, recipes);
  const candidate = {
    version: 1, quoteNumber: quoteNumberOf(order), businessName: settings.businessName, issuedAt: opts.issuedAt,
    ...(settings.businessPhone ? { businessPhone: settings.businessPhone } : {}),
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
    ...(lines.priced ? { items: lines.items } : { items: [{ description: BUNDLED_LINE, quantity: 1, unitPriceCents: lines.totalCents }], includedItems: lines.included }),
    ...(opts.deliveryFee ? { deliveryFeeCents: toCents(opts.deliveryFee) } : {}),
    ...(opts.discount ? { discountCents: toCents(opts.discount) } : {}),
    ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
  };
  const v = validatePublicQuote(candidate);
  if (v.ok) return { ok: true, quote: v.quote };
  const why: Record<string, string> = { INVALID_DATE: 'A validade deve ser uma data igual ou posterior à emissão.', INVALID_PHONE: 'O telefone do negócio é inválido. Corrija em Configurações.', DISCOUNT_EXCEEDS_TOTAL: 'O desconto não pode ser maior que o total.', TOO_LONG: 'Algum texto está longo demais.', INVALID_PRICE: 'Algum valor está inválido.', INVALID_QUANTITY: 'A quantidade da encomenda é inválida para um orçamento.', TOTAL_TOO_LARGE: 'O total é grande demais para um orçamento.' };
  return { ok: false, error: why[v.error] ?? 'Não foi possível montar o orçamento com estes dados.' };
}

/** Texto do botão "Copiar orçamento" (WhatsApp). Mesma regra de apresentação do link público: nunca discrimina embalagens nem custos. */
export function buildQuoteText(order: Order, recipes: readonly Recipe[], code: string): string {
  const lines = publicLines(order, recipes);
  const products = lines.priced
    ? lines.items.map(i => `• ${describeQuantity(i)}${i.quantity === 1 ? '' : ` (${formatCents(i.unitPriceCents)} cada)`}: ${formatCents(toCents(itemSubtotal(i.quantity, i.unitPriceCents / 100)))}`)
    : lines.included.map(i => `• ${describeQuantity(i)}`);
  return [`Olá, ${order.customer}! Segue seu orçamento ${code}:`, ...products, `Total: ${formatCents(toCents(orderTotal(order)))}`, `Data solicitada: ${order.deliveryDate.split('-').reverse().join('/')}`, 'Condições de pagamento e disponibilidade sujeitas à confirmação.'].join('\n');
}

export const whatsappShareUrl = (quote: PublicQuote, link: string): string =>
  `https://wa.me/?text=${encodeURIComponent(`Olá! Segue seu orçamento da ${quote.businessName}, nº ${quote.quoteNumber}. Acesse: ${link}`)}`;

export { computeTotals };

export type PublishedQuote = { id: string; status: 'active' | 'expired' | 'revoked'; quoteNumber: string; businessName: string; issuedAt: string; validUntil: string | null; totalCents: number; createdAt: string; url?: string };
export type QuoteFailure = 'network' | 'unauthorized' | 'no-license' | 'quota-active' | 'quota-daily' | 'rate-limited' | 'invalid' | 'unexpected';
export type QuoteResult<T> = { ok: true; value: T } | { ok: false; reason: QuoteFailure; retryAfter?: number };

export function createQuotesClient(base: string, getCsrf: () => string | undefined, fetchImpl: typeof fetch = fetch) {
  const fail = (res: { status: number; body: unknown; retryAfter?: number }): QuoteResult<never> => {
    const code = field<string>(res.body, 'error');
    if (res.status === 429) return { ok: false, reason: code === 'QUOTA_ACTIVE_EXCEEDED' ? 'quota-active' : code === 'QUOTA_DAILY_EXCEEDED' ? 'quota-daily' : 'rate-limited', ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}) };
    if (res.status === 401 || res.status === 403 && code === 'CSRF') return { ok: false, reason: 'unauthorized' };
    if (res.status === 403) return { ok: false, reason: 'no-license' };
    if (res.status === 400 || res.status === 413) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unexpected' };
  };
  return {
    async publish(quote: PublicQuote): Promise<QuoteResult<{ id: string; url: string }>> {
      const res = await apiCall(base, '/api/quotes', { method: 'POST', body: quote, csrf: getCsrf() }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      const id = field<string>(res.body, 'id'); const url = field<string>(res.body, 'url') ?? (id ? `${base}/o/${id}` : undefined);
      return res.status === 201 && id && url ? { ok: true, value: { id, url } } : fail(res);
    },
    async list(): Promise<QuoteResult<PublishedQuote[]>> {
      const res = await apiCall(base, '/api/quotes', {}, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 ? { ok: true, value: field<PublishedQuote[]>(res.body, 'quotes') ?? [] } : fail(res);
    },
    async revoke(id: string): Promise<QuoteResult<true>> {
      const res = await apiCall(base, `/api/quotes/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: getCsrf() }, fetchImpl);
      if (!res) return { ok: false, reason: 'network' };
      return res.status === 200 ? { ok: true, value: true } : fail(res);
    },
  };
}
export type QuotesClient = ReturnType<typeof createQuotesClient>;

export const QUOTE_MESSAGES: Record<QuoteFailure, string> = {
  network: 'Sem conexão com o servidor. Tente de novo quando estiver online.',
  unauthorized: 'Sua sessão expirou. Entre novamente em Configurações.',
  'no-license': 'Sua licença não permite publicar orçamentos.',
  'quota-active': 'Você atingiu o limite de links ativos. Revogue links antigos para liberar espaço.',
  'quota-daily': 'Você atingiu o limite de links criados hoje. Tente amanhã.',
  'rate-limited': 'Muitas requisições. Aguarde um instante e tente novamente.',
  invalid: 'O servidor recusou este orçamento. Confira os dados.',
  unexpected: 'Resposta inesperada do servidor. Tente novamente mais tarde.',
};
