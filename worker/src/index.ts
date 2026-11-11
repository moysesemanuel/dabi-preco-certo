import { computeTotals, LIMITS, validatePublicQuote, type PublicQuote } from '../../shared/publicQuote';
import { renderMessagePage, renderQuotePage } from './render';
import { createLicenseAuthorizer, DEFAULT_LIMITS, type AuthResult, type Authorizer } from './auth';
import { countQuotaUsage, generateId, getQuote, ID_PATTERN, insertQuoteWithinQuotas, revokeQuote, updateQuotePayload, type D1Like, type QuoteRow } from './store';

export interface Env {
  DB: D1Like;
  /** Origem pública dos links, ex.: https://orcamento.dabitech.com.br (sem barra final). */
  PUBLIC_BASE_URL?: string;
  /** Origens do app autorizadas a chamar a API (CORS), separadas por vírgula. Vazio = nenhuma. */
  ALLOWED_ORIGINS?: string;
}

export type { Authorizer, AuthResult };

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

/** Início do dia atual no Brasil, em UTC (00:00 em UTC-3 = 03:00Z). Usado na cota diária. */
const dayStartUtc = (now: Date) => `${todayInBrazil(now)}T03:00:00.000Z`;

function authFailure(f: Extract<AuthResult, { ok: false }>): Response {
  const extra: Record<string, string> = {};
  if (f.status === 401) extra['WWW-Authenticate'] = 'Bearer realm="dabi-orcamentos"';
  if (f.retryAfterSeconds !== undefined) extra['Retry-After'] = String(f.retryAfterSeconds);
  return respond(JSON.stringify({ error: f.error, message: f.message }), f.status, 'application/json; charset=utf-8', extra);
}

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
    // A autorização vem ANTES de ler o corpo: sem licença válida (e dentro do limite de taxa), nada é processado nem gravado.
    const auth = await options.authorize(request, env, { scope: 'write', now: now() });
    if (!auth.ok) return authFailure(auth);

    if (method === 'POST' && id === undefined) {
      const body = await readJsonBody(request);
      if (!body.ok) return apiError(body.status, body.error, 'Corpo da requisição inválido.');
      const v = validatePublicQuote(body.data);
      if (!v.ok) return json({ error: 'INVALID_QUOTE', code: v.error, field: v.field }, 400);
      const newQuoteId = newId();
      const current = now();
      const limits = auth.limits ?? { quotaActive: DEFAULT_LIMITS.quotaActive, quotaDaily: DEFAULT_LIMITS.quotaDaily };
      const inserted = await insertQuoteWithinQuotas(env.DB, { id: newQuoteId, payload: JSON.stringify(v.quote), now: current.toISOString(), ownerId: auth.ownerId, dayStartIso: dayStartUtc(current), quotaActive: limits.quotaActive, quotaDaily: limits.quotaDaily });
      if (!inserted.ok) {
        const message = inserted.reason === 'ACTIVE'
          ? 'Você atingiu o limite de orçamentos ativos. Revogue orçamentos antigos para liberar espaço.'
          : 'Você atingiu o limite de orçamentos criados hoje. Tente novamente amanhã.';
        return json({ error: inserted.reason === 'ACTIVE' ? 'QUOTA_ACTIVE_EXCEEDED' : 'QUOTA_DAILY_EXCEEDED', message, used: inserted.used, limit: inserted.limit }, 429);
      }
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

  /** Verifica a licença e informa o uso das cotas. Usada pelo botão "Ativar/verificar" do app. */
  async function verifyLicense(request: Request, env: Env): Promise<Response> {
    const auth = await options.authorize(request, env, { scope: 'verify', now: now() });
    if (!auth.ok) return authFailure(auth);
    const limits = auth.limits ?? { quotaActive: DEFAULT_LIMITS.quotaActive, quotaDaily: DEFAULT_LIMITS.quotaDaily };
    const usage = await countQuotaUsage(env.DB, auth.ownerId, dayStartUtc(now()));
    return json({ status: 'active', licenseId: auth.ownerId, quotas: { active: { used: usage?.active ?? 0, limit: limits.quotaActive }, daily: { used: usage?.today ?? 0, limit: limits.quotaDaily } } });
  }

  /** CORS só para origens explicitamente autorizadas; a chave vai em cabeçalho, sem cookies. */
  function withCors(request: Request, env: Env, response: Response): Response {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Expose-Headers', 'Retry-After');
      response.headers.append('Vary', 'Origin');
    }
    return response;
  }

  async function route(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const method = request.method.toUpperCase();

      const page = pathname.match(/^\/o\/([^/]+)\/?$/);
      if (page) {
        if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
        return await readQuote(env, page[1], method === 'HEAD', false);
      }
      if (/^\/api\/license\/?$/.test(pathname)) {
        return method === 'GET' ? await verifyLicense(request, env) : apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }
      const api = pathname.match(/^\/api\/quotes(?:\/([^/]+))?\/?$/);
      if (api) {
        const id = api[1];
        if (method === 'GET' && id !== undefined) return await readQuote(env, id, false, true); // leitura pública: sem autenticação
        if ((method === 'POST' && id === undefined) || ((method === 'PUT' || method === 'DELETE') && id !== undefined)) return await write(request, env, method, id);
        return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }
      if (pathname === '/healthz') return json({ ok: true });
      return html(renderMessagePage('Página não encontrada', 'Este endereço não existe.'), 404, method === 'HEAD');
    } catch {
      // Não expõe detalhes internos, chaves nem dados do orçamento em erros.
      return apiError(500, 'INTERNAL_ERROR', 'Erro interno.');
    }
  }

  return async function handle(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method.toUpperCase() === 'OPTIONS' && pathname.startsWith('/api/')) {
      const preflight = new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } });
      return withCors(request, env, preflight);
    }
    return withCors(request, env, await route(request, env));
  };
}

// O Worker publicado autoriza SOMENTE por chave de licença individual (veja auth.ts).
const handler = createHandler({ authorize: createLicenseAuthorizer() });
export default {
  fetch: (request: Request, env: Env) => handler(request, env),
};
