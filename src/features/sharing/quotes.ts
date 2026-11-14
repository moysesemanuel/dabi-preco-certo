import { computeTotals, validatePublicQuote, type PublicQuote } from '../../../shared/publicQuote';
import { legacyQuoteCode } from '../../../shared/quoteCode';
import { apiCall, field } from '../../account/http';
import type { Order, Recipe, Settings } from '../../domain/types';

/**
 * Monta o orçamento PÚBLICO a partir de uma encomenda. Inclui só o que o cliente pode ver:
 * produto, quantidade, valor unitário, entrega, desconto, validade e observações.
 * Nunca inclui custo, margem, preço de compra, nome/telefone do cliente ou registros internos.
 */
export type QuoteOptions = { issuedAt: string; validUntil?: string; deliveryFee?: number; discount?: number; notes?: string };
export const toCents = (reais: number) => Math.round((reais + Number.EPSILON) * 100);
/** Número do orçamento = código permanente de atendimento do pedido (nunca o id interno nem o token do link). */
export const quoteNumberOf = (order: Pick<Order, 'id' | 'quoteCode'>) => order.quoteCode ?? legacyQuoteCode(order.id);

export function buildPublicQuote(order: Order, recipe: Recipe | undefined, settings: Settings | undefined, opts: QuoteOptions): { ok: true; quote: PublicQuote } | { ok: false; error: string } {
  if (!settings?.businessName) return { ok: false, error: 'Informe o nome do negócio em Configurações antes de gerar o orçamento.' };
  if (!recipe) return { ok: false, error: 'A receita desta encomenda não está mais disponível.' };
  const candidate = {
    version: 1, quoteNumber: quoteNumberOf(order), businessName: settings.businessName, issuedAt: opts.issuedAt,
    ...(settings.businessPhone ? { businessPhone: settings.businessPhone } : {}),
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
    items: [
      { description: recipe.name, quantity: order.quantity, unitPriceCents: toCents(order.unitPrice) },
      ...(order.packagingCharge && order.packagingCharge > 0
        ? [{ description: 'Embalagens adicionais', quantity: 1, unitPriceCents: toCents(order.packagingCharge) }]
        : []),
    ],
    ...(opts.deliveryFee ? { deliveryFeeCents: toCents(opts.deliveryFee) } : {}),
    ...(opts.discount ? { discountCents: toCents(opts.discount) } : {}),
    ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
  };
  const v = validatePublicQuote(candidate);
  if (v.ok) return { ok: true, quote: v.quote };
  const why: Record<string, string> = { INVALID_DATE: 'A validade deve ser uma data igual ou posterior à emissão.', INVALID_PHONE: 'O telefone do negócio é inválido. Corrija em Configurações.', DISCOUNT_EXCEEDS_TOTAL: 'O desconto não pode ser maior que o total.', TOO_LONG: 'Algum texto está longo demais.', INVALID_PRICE: 'Algum valor está inválido.', INVALID_QUANTITY: 'A quantidade da encomenda é inválida para um orçamento.', TOTAL_TOO_LARGE: 'O total é grande demais para um orçamento.' };
  return { ok: false, error: why[v.error] ?? 'Não foi possível montar o orçamento com estes dados.' };
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
