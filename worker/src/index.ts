import { computeTotals, LIMITS, validatePublicQuote, type PublicQuote } from '../../shared/publicQuote';
import { renderMessagePage, renderQuotePage } from './render';
import { generateId, getQuote, ID_PATTERN, insertQuote, revokeQuote, updateQuotePayload, type D1Like, type QuoteRow } from './store';

export interface Env {
  DB: D1Like;
  /** Origem pública dos links, ex.: https://orcamento.dabitech.com.br (sem barra final). */
  PUBLIC_BASE_URL?: string;
}

/**
 * Decide quem pode publicar, atualizar ou revogar orçamentos. AINDA NÃO EXISTE autenticação:
 * o Worker publicado usa `denyAll`, então os endpoints de escrita respondem 501 e nada é gravado.
 * Os testes injetam um autorizador falso; não há caminho em produção para trocá-lo sem implementar a autenticação.
 */
export type Authorizer = (request: Request, env: Env) => Promise<{ ok: true; ownerId: string } | { ok: false }>;
export const denyAll: Authorizer = async () => ({ ok: false });

type Options = { authorize: Authorizer; now?: () => Date; newId?: () => string };

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

function respond(body: BodyInit | null, status: number, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': contentType, ...extra } });
}
const json = (data: unknown, status = 200) => respond(JSON.stringify(data), status, 'application/json; charset=utf-8');
const apiError = (status: number, error: string, message: string) => json({ error, message }, status);
const html = (body: string, status = 200, head = false) => respond(head ? null : body, status, 'text/html; charset=utf-8');

/** Data de hoje no Brasil (UTC-3, sem horário de verão), para decidir se a validade encerrou. */
const todayInBrazil = (now: Date) => new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

function readStored(row: QuoteRow): PublicQuote | undefined {
  try {
    const parsed = validatePublicQuote(JSON.parse(row.payload));
    return parsed.ok ? parsed.quote : undefined; // dado corrompido nunca é exibido
  } catch { return undefined; }
}

/** Lê o corpo JSON com limite real de tamanho (não confia só no Content-Length). */
async function readJsonBody(request: Request): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > LIMITS.maxBodyBytes) return { ok: false, status: 413, error: 'BODY_TOO_LARGE' };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.maxBodyBytes) return { ok: false, status: 413, error: 'BODY_TOO_LARGE' };
  try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: false, status: 400, error: 'INVALID_JSON' }; }
}

export function createHandler(options: Options) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? generateId;

  async function readQuote(env: Env, id: string, head: boolean, wantJson: boolean): Promise<Response> {
    const notFound = () => (wantJson ? apiError(404, 'NOT_FOUND', 'Orçamento não encontrado.') : html(renderMessagePage('Orçamento não encontrado', 'Verifique se o link está completo ou peça um novo link ao vendedor.'), 404, head));
    if (!ID_PATTERN.test(id)) return notFound();
    const row = await getQuote(env.DB, id);
    if (!row) return notFound();
    if (row.revoked_at) return wantJson ? apiError(410, 'REVOKED', 'Este orçamento foi retirado pelo vendedor.') : html(renderMessagePage('Orçamento indisponível', 'Este orçamento foi retirado pelo vendedor. Peça um novo link, se necessário.'), 410, head);
    const quote = readStored(row);
    if (!quote) return wantJson ? apiError(500, 'CORRUPTED', 'Não foi possível exibir este orçamento.') : html(renderMessagePage('Orçamento indisponível', 'Não foi possível exibir este orçamento.'), 500, head);
    const expired = !!quote.validUntil && quote.validUntil < todayInBrazil(now());
    if (wantJson) return json({ id: row.id, status: expired ? 'expired' : 'active', quote, totals: computeTotals(quote), updatedAt: row.updated_at });
    return html(renderQuotePage(quote, { expired }), 200, head);
  }

  async function write(request: Request, env: Env, method: string, id: string | undefined): Promise<Response> {
    // A autorização vem ANTES de ler o corpo: sem credencial válida, nada é processado nem gravado.
    const auth = await options.authorize(request, env);
    if (!auth.ok) return apiError(501, 'PUBLISHING_DISABLED', 'A publicação de orçamentos ainda não está habilitada.');

    if (method === 'POST' && id === undefined) {
      const body = await readJsonBody(request);
      if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
      const v = validatePublicQuote(body.data);
      if (!v.ok) return json({ error: 'INVALID_QUOTE', code: v.error, field: v.field }, 400);
      const newQuoteId = newId();
      const stamp = now().toISOString();
      await insertQuote(env.DB, { id: newQuoteId, payload: JSON.stringify(v.quote), now: stamp, ownerId: auth.ownerId });
      const path = `/o/${newQuoteId}`;
      return json({ id: newQuoteId, path, ...(env.PUBLIC_BASE_URL ? { url: `${env.PUBLIC_BASE_URL}${path}` } : {}) }, 201);
    }

    if (id === undefined || !ID_PATTERN.test(id)) return apiError(404, 'NOT_FOUND', 'Orçamento não encontrado.');
    const row = await getQuote(env.DB, id);
    // Quem não é o dono recebe 404, igual a um id inexistente, para não revelar que o orçamento existe.
    if (!row || row.owner_id !== auth.ownerId) return apiError(404, 'NOT_FOUND', 'Orçamento não encontrado.');

    if (method === 'DELETE') {
      if (!row.revoked_at) await revokeQuote(env.DB, id, auth.ownerId, now().toISOString());
      return json({ id, revoked: true });
    }
    // PUT
    if (row.revoked_at) return apiError(410, 'REVOKED', 'Orçamento revogado não pode ser alterado.');
    const body = await readJsonBody(request);
    if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
    const v = validatePublicQuote(body.data);
    if (!v.ok) return json({ error: 'INVALID_QUOTE', code: v.error, field: v.field }, 400);
    await updateQuotePayload(env.DB, id, auth.ownerId, JSON.stringify(v.quote), now().toISOString());
    return json({ id, updated: true });
  }

  return async function handle(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const method = request.method.toUpperCase();

      const page = pathname.match(/^\/o\/([^/]+)\/?$/);
      if (page) {
        if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
        return readQuote(env, page[1], method === 'HEAD', false);
      }
      const api = pathname.match(/^\/api\/quotes(?:\/([^/]+))?\/?$/);
      if (api) {
        const id = api[1];
        if (method === 'GET' && id !== undefined) return readQuote(env, id, false, true);
        if ((method === 'POST' && id === undefined) || ((method === 'PUT' || method === 'DELETE') && id !== undefined)) return write(request, env, method, id);
        return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }
      if (pathname === '/healthz') return json({ ok: true });
      return html(renderMessagePage('Página não encontrada', 'Este endereço não existe.'), 404, method === 'HEAD');
    } catch {
      // Não expõe detalhes internos nem dados do orçamento em erros.
      return apiError(500, 'INTERNAL_ERROR', 'Erro interno.');
    }
  };
}

export default {
  fetch: (request: Request, env: Env) => createHandler({ authorize: denyAll })(request, env),
};
