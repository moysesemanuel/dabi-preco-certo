import { computeTotals, validatePublicQuote, type PublicQuote } from '../../shared/publicQuote';
import { apiError, html, json, readJsonBody, respond, SECURITY_HEADERS } from './http';
import { renderMessagePage, renderQuotePage } from './render';
import { createLicenseAuthorizer, DEFAULT_LIMITS, type AuthResult, type Authorizer } from './auth';
import { currentSession, logout, requestCode, sessionRevoke, sessionsList, verifyCode, type AuthEnv } from './authRoutes';
import { createEmailSender, type EmailSender } from './email';
import { createCompositeAuthorizer } from './session';
import { adminRoute } from './adminRoutes';
import { syncPull, syncPush } from './syncRoutes';
import { countQuotaUsage, generateId, getQuote, ID_PATTERN, insertQuoteWithinQuotas, listQuotesByOwner, revokeQuote, updateQuotePayload, type D1Like, type QuoteRow } from './store';

export interface Env {
  DB: D1Like;
  /** Origem pública dos links, ex.: https://orcamento.dabitech.com.br (sem barra final). */
  PUBLIC_BASE_URL?: string;
  /** Origens do app autorizadas a chamar a API (CORS), separadas por vírgula. Vazio = nenhuma. */
  ALLOWED_ORIGINS?: string;
  /** SEGREDO do servidor (wrangler secret) usado para proteger os códigos de acesso. Sem ele, o login responde 503. */
  AUTH_SECRET?: string;
  /** `resend` envia pelo Resend (exige RESEND_API_KEY e EMAIL_FROM); `dev` imprime no terminal (só com origens locais). Sem valor, não há envio e o login responde 503. */
  EMAIL_ADAPTER?: string;
  /** SEGREDO (wrangler secret) do provedor Resend. Nunca em arquivos versionados. */
  RESEND_API_KEY?: string;
  /** Remetente verificado no Resend, ex.: `PedidoCerto <acesso@seudominio.com.br>`. Não é segredo. */
  EMAIL_FROM?: string;
  /** Limite diário de e-mails de código de acesso (padrão 80, abaixo dos 100/dia do plano gratuito do Resend). Ajuste ao mudar de plano. */
  EMAIL_DAILY_LIMIT?: string;
  /** `on` reativa a autenticação antiga por chave de licença (Bearer). Padrão: desligada. */
  LEGACY_KEY_AUTH?: string;
}

export type { Authorizer, AuthResult };

type Options = { authorize: Authorizer; now?: () => Date; newId?: () => string; email?: (env: Env) => EmailSender };

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

export function createHandler(options: Options) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? generateId;
  const authDeps = { now, email: options.email ?? ((env: AuthEnv) => createEmailSender(env)) };

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

  /** GET /api/quotes: os orçamentos publicados pelo próprio usuário (para consultar e revogar links). */
  async function listMine(request: Request, env: Env): Promise<Response> {
    const auth = await options.authorize(request, env, { scope: 'verify', now: now() });
    if (!auth.ok) return authFailure(auth);
    const today = todayInBrazil(now());
    const rows = await listQuotesByOwner(env.DB, auth.ownerId);
    const quotes = rows.flatMap(row => {
      const quote = readStored(row);
      if (!quote) return [];
      const status = row.revoked_at ? 'revoked' : quote.validUntil && quote.validUntil < today ? 'expired' : 'active';
      return [{ id: row.id, status, quoteNumber: quote.quoteNumber, businessName: quote.businessName, issuedAt: quote.issuedAt, validUntil: quote.validUntil ?? null, totalCents: computeTotals(quote).totalCents, createdAt: row.created_at, updatedAt: row.updated_at, ...(env.PUBLIC_BASE_URL ? { url: `${env.PUBLIC_BASE_URL}/o/${row.id}` } : {}) }];
    });
    return json({ quotes });
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
      response.headers.set('Access-Control-Allow-Credentials', 'true'); // cookie de sessão (somente origens autorizadas)
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
      if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/sessions')) {
        const r = pathname.replace(/\/+$/, '');
        if (r === '/api/auth/request-code' && method === 'POST') return await requestCode(request, env, authDeps);
        if (r === '/api/auth/verify-code' && method === 'POST') return await verifyCode(request, env, authDeps);
        if (r === '/api/auth/session' && method === 'GET') return await currentSession(request, env, authDeps);
        if (r === '/api/auth/logout' && method === 'POST') return await logout(request, env, authDeps);
        if (r === '/api/sessions' && method === 'GET') return await sessionsList(request, env, authDeps);
        const del = r.match(/^\/api\/sessions\/([^/]+)$/);
        if (del && method === 'DELETE') return await sessionRevoke(request, env, authDeps, del[1]);
        return apiError(404, 'NOT_FOUND', 'Rota não encontrada.');
      }
      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) return (await adminRoute(request, env, { now }, pathname)) ?? apiError(404, 'NOT_FOUND', 'Rota não encontrada.');
      if (pathname === '/api/sync' || pathname === '/api/sync/push') {
        if (pathname === '/api/sync' && method === 'GET') return await syncPull(request, env, authDeps);
        if (pathname === '/api/sync/push' && method === 'POST') return await syncPush(request, env, authDeps);
        return apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }
      if (/^\/api\/license\/?$/.test(pathname)) {
        return method === 'GET' ? await verifyLicense(request, env) : apiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
      }
      const api = pathname.match(/^\/api\/quotes(?:\/([^/]+))?\/?$/);
      if (api) {
        const id = api[1];
        if (method === 'GET' && id === undefined) return await listMine(request, env);
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
      const preflight = new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-CSRF-Token', 'Access-Control-Max-Age': '600' } });
      return withCors(request, env, preflight);
    }
    return withCors(request, env, await route(request, env));
  };
}

// O Worker publicado autoriza por SESSÃO de conta (cookie + CSRF). A chave de licença antiga só vale com LEGACY_KEY_AUTH=on.
const handler = createHandler({ authorize: createCompositeAuthorizer(createLicenseAuthorizer()) });
export default {
  fetch: (request: Request, env: Env) => handler(request, env),
};
