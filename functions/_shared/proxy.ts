/**
 * Proxy same-origin do Cloudflare Pages para o Worker da API (Service Binding `API`).
 *
 * Por que existe: com app e API no MESMO host (ex.: https://precocerto.dabitech.com.br e /api/*), o cookie de sessão
 * (`__Host-dabi_session`, HttpOnly, Secure, SameSite=Lax, sem Domain) é de primeira parte e nenhuma regra de CORS entra em jogo.
 *
 * Segurança (nada aqui é um proxy aberto):
 *  - o destino é SEMPRE o Service Binding `API`, definido no projeto Pages; a URL do cliente nunca escolhe o destino;
 *  - só caminhos `/api/*` e `/o/*` (links públicos de orçamento) são encaminhados; qualquer outro, e caminhos com `..`, `%2f` ou `\`, são recusados;
 *  - só os métodos usados pela API; corpo grande demais é recusado antes de gastar processamento (o Worker aplica os limites reais);
 *  - cabeçalhos, cookies, corpo, método, status e Set-Cookie passam sem alteração; o único cabeçalho acrescentado é `X-Dabi-Expect-Env`
 *    (o Worker recusa com 421 se for de outro ambiente, impedindo que um Pages de homologação use o banco de produção por engano);
 *  - respostas sem Cache-Control recebem `no-store` (nada autenticado fica em cache);
 *  - falhas do Worker viram 502 genérico, sem detalhes internos.
 */
export type Fetcher = { fetch(request: Request): Promise<Response> };
export type ProxyEnv = { API?: Fetcher; /** `staging` ou `production`; configurado em cada projeto Pages. */ APP_ENV?: string };

export const FORWARDED_PREFIXES = ['/api/', '/o/'] as const;
export const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'] as const;
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const EDGE_HEALTH_PATH = '/api/_edge/health';
export const EXPECT_ENV_HEADER = 'x-dabi-expect-env';
const ENVIRONMENTS = new Set(['staging', 'production']);

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
});

export async function proxy(request: Request, env: ProxyEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (!FORWARDED_PREFIXES.some(p => path.startsWith(p) && path.length > p.length)) return reply(404, { error: 'NOT_FOUND' });
  // eslint-disable-next-line no-control-regex
  if (/%2f|%5c|%00|\\|[\u0000-\u001f]/i.test(path) || path.split('/').some(s => s === '.' || s === '..')) return reply(400, { error: 'INVALID_PATH' });
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) return reply(405, { error: 'METHOD_NOT_ALLOWED' }, { allow: ALLOWED_METHODS.join(', ') });

  // Diagnóstico de implantação (não passa pelo Worker): diz só o ambiente do projeto Pages e se o binding existe.
  if (path === EDGE_HEALTH_PATH && (method === 'GET' || method === 'HEAD')) return reply(200, { ok: Boolean(env.API) && ENVIRONMENTS.has(env.APP_ENV ?? ''), env: env.APP_ENV ?? null, binding: Boolean(env.API) });

  if (!env.API || typeof env.API.fetch !== 'function' || !ENVIRONMENTS.has(env.APP_ENV ?? '')) return reply(503, { error: 'PROXY_NOT_CONFIGURED', message: 'O projeto Pages não tem o Service Binding API e a variável APP_ENV configurados.' });
  if (Number(request.headers.get('content-length') ?? '0') > MAX_REQUEST_BYTES) return reply(413, { error: 'BODY_TOO_LARGE' });

  const headers = new Headers(request.headers);
  headers.set(EXPECT_ENV_HEADER, env.APP_ENV as string); // sobrescreve qualquer valor enviado pelo cliente
  const upstream = new Request(request, { headers, redirect: 'manual' });
  let response: Response;
  try { response = await env.API.fetch(upstream); } catch { return reply(502, { error: 'UPSTREAM_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' }); }
  const out = new Response(response.body, response);
  if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'no-store');
  return out;
}
