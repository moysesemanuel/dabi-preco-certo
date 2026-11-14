import { proxy, type ProxyEnv } from '../_shared/proxy';

/** `/api/*` → Worker da API (Service Binding). Veja functions/_shared/proxy.ts e docs/PUBLICACAO_CLOUDFLARE.md. */
export const onRequest = (context: { request: Request; env: ProxyEnv }): Promise<Response> => proxy(context.request, context.env);
