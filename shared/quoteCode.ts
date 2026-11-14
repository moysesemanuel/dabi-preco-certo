/**
 * Código permanente de atendimento do orçamento/encomenda: "ORC-" + 6 caracteres (ex.: ORC-K7M42P).
 *  - Alfabeto de 30 símbolos sem caracteres ambíguos (sem 0, 1, I, L, O, U): legível por telefone e WhatsApp. 30^6 ≈ 729 milhões de códigos.
 *  - Gerado no próprio aparelho (offline) com números aleatórios criptográficos: não depende de contador central, não é sequencial
 *    e não deriva do id interno nem do token do link público. NÃO é credencial: só identifica o atendimento; nada é consultado por ele.
 *  - Colisão: o app confere os códigos que já conhece e o servidor garante unicidade por conta (índice único); se duas pontas gerarem
 *    o mesmo código offline, o servidor recusa o envio e o app troca o código ainda não confirmado (veja engine.ts).
 *  - Encomendas antigas (sem código) recebem um código DETERMINÍSTICO a partir do id: todos os aparelhos chegam ao mesmo valor,
 *    então não há conflito de sincronização. Só o código é acrescentado; nada financeiro é tocado.
 */
export const QUOTE_CODE_PREFIX = 'ORC-';
export const QUOTE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LEN = 6;
const A = QUOTE_CODE_ALPHABET.length; // 30
export const QUOTE_CODE_PATTERN = /^ORC-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/;
export const isQuoteCode = (v: unknown): v is string => typeof v === 'string' && QUOTE_CODE_PATTERN.test(v);

/** Gera um código aleatório (sem viés: bytes >= 240 são descartados). */
export function generateQuoteCode(randomBytes: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  while (out.length < LEN) for (const b of randomBytes(LEN * 2)) { if (b < 240 && out.length < LEN) out += QUOTE_CODE_ALPHABET[b % A]; }
  return QUOTE_CODE_PREFIX + out;
}

/** Gera um código que ainda não existe em `used` (e o reserva). */
export function uniqueQuoteCode(used: Set<string>, randomBytes?: (n: number) => Uint8Array): string {
  for (let i = 0; i < 50; i++) { const c = generateQuoteCode(randomBytes); if (!used.has(c)) { used.add(c); return c; } }
  throw new Error('Não foi possível gerar um código de orçamento único.');
}

// Hash não criptográfico (cyrb53) só para derivar códigos de encomendas antigas de forma reprodutível em qualquer aparelho.
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function legacyQuoteCode(orderId: string, salt = 0): string {
  let n = cyrb53(`orc:${orderId}:${salt}`), out = '';
  for (let i = 0; i < LEN; i++) { out += QUOTE_CODE_ALPHABET[n % A]; n = Math.floor(n / A); }
  return QUOTE_CODE_PREFIX + out;
}

type CodedOrder = { id: string; createdAt: string; quoteCode?: string };
/** Código efetivo de cada encomenda: o gravado; ou, se ainda não houver, o derivado do id (com desempate determinístico em colisões). */
export function effectiveQuoteCodes(orders: readonly CodedOrder[]): Map<string, string> {
  const out = new Map<string, string>(), used = new Set<string>();
  for (const o of orders) if (o.quoteCode) { out.set(o.id, o.quoteCode); used.add(o.quoteCode); }
  const missing = orders.filter(o => !o.quoteCode).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  for (const o of missing) { let salt = 0, c = legacyQuoteCode(o.id, salt); while (used.has(c)) c = legacyQuoteCode(o.id, ++salt); used.add(c); out.set(o.id, c); }
  return out;
}

/** Grava o código efetivo nas encomendas que ainda não têm um (devolve a mesma lista se nada mudou). */
export function withQuoteCodes<T extends CodedOrder>(orders: T[]): T[] {
  if (orders.every(o => o.quoteCode)) return orders;
  const codes = effectiveQuoteCodes(orders);
  return orders.map(o => (o.quoteCode ? o : { ...o, quoteCode: codes.get(o.id)! }));
}

/** Normaliza o que a pessoa digita ao procurar um código: aceita com ou sem "ORC", com ou sem hífen, em qualquer caixa. Devolve só os caracteres. */
export const normalizeCodeQuery = (q: string): string => q.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ORC/, '');
