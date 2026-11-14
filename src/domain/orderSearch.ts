import { normalizeCodeQuery } from '../../shared/quoteCode';
import type { Order } from './types';

/** Minúsculas, sem acentos nem pontuação, espaços simples. */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const alnum = (s: string) => norm(s).replace(/ /g, '');

export type SearchContext = {
  /** Código de atendimento efetivo de cada encomenda (`effectiveQuoteCodes`). */
  codes: Map<string, string>;
  /** Nome do produto/receita de cada encomenda. */
  productOf: (order: Order) => string;
};

/**
 * Filtra encomendas por código de atendimento, cliente, produto (receita) e status. Todas as palavras digitadas precisam aparecer
 * (em qualquer um desses campos). Ignora caixa e acentos; o código vale com ou sem "ORC-" e com ou sem hífen ("k7m42p", "orc-k7m", "ORCK7M").
 * Nunca procura em identificadores internos (ids) nem em dados financeiros. Opera sobre TODAS as encomendas, não só as visíveis.
 */
export function filterOrders(orders: readonly Order[], query: string, ctx: SearchContext): Order[] {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...orders];
  return orders.filter(o => {
    const text = norm(`${o.customer} ${ctx.productOf(o)} ${o.status}`);
    const code = (ctx.codes.get(o.id) ?? '').toLowerCase().replace(/-/g, '');            // "orck7m42p"
    const body = normalizeCodeQuery(ctx.codes.get(o.id) ?? '').toLowerCase();             // "k7m42p"
    return tokens.every(t => {
      const n = norm(t), a = alnum(t);
      return (n && text.includes(n)) || (a.length >= 2 && (code.includes(a) || body.includes(a)));
    });
  });
}
