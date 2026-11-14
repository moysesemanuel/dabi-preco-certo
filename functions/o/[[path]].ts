import { proxy, type ProxyEnv } from '../_shared/proxy';

/** `/o/*` → páginas públicas de orçamento, renderizadas pelo Worker (somente leitura; o Worker valida o identificador). */
export const onRequest = (context: { request: Request; env: ProxyEnv }): Promise<Response> => proxy(context.request, context.env);
