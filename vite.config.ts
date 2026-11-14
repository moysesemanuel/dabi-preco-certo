import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SOMENTE DESENVOLVIMENTO. Com `DEV_API_PROXY_TARGET` definido, o servidor do Vite repassa `/api` para essa API (ex.: homologação),
 * de modo que o app (VITE_API_URL=same-origin) e a API fiquem na MESMA origem para o navegador. Sem isso, o cookie de sessão
 * (SameSite=Lax) de uma API em outro site (workers.dev) não acompanha as chamadas do app em 127.0.0.1.
 * O proxy NÃO enfraquece nada no servidor: ele só adapta o nome do cookie e o atributo Secure para o http local, e só existe no
 * `vite dev` (nunca entra no build de produção).
 */
export function devApiProxy(target: string | undefined): Record<string, ProxyOptions> | undefined {
  if (!target) return undefined;
  const u = new URL(target); // lança se inválido: o servidor de desenvolvimento não sobe com alvo errado
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('DEV_API_PROXY_TARGET precisa ser https (ou localhost).');
  const secure = u.protocol === 'https:';
  return {
    '/api': {
      target: u.origin, changeOrigin: true, secure: true,
      configure: proxy => {
        // Resposta: o servidor emite `__Host-dabi_session=...; Secure` (porque fala https). No navegador, em http local, isso seria
        // recusado; reescreve para `dabi_session` sem Secure. O token continua HttpOnly e SameSite=Lax.
        proxy.on('proxyRes', res => {
          const set = res.headers['set-cookie'];
          if (set) res.headers['set-cookie'] = set.map(c => c.replace(/^__Host-/, '').replace(/;\s*Secure/gi, ''));
        });
        // Requisição: devolve o cookie com o nome que o servidor (https) espera.
        proxy.on('proxyReq', req => {
          const cookie = req.getHeader('cookie');
          if (secure && typeof cookie === 'string') req.setHeader('cookie', cookie.replace(/(^|;\s*)dabi_session=/, '$1__Host-dabi_session='));
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: devApiProxy(process.env.DEV_API_PROXY_TARGET),
  },
});