import { describe, expect, it } from 'vitest';
import { devApiProxy } from '../vite.config';

// O proxy é só de desenvolvimento; estes testes garantem que ele não vira um jeito de enfraquecer a sessão.
type Handler = (...a: never[]) => void;
function wire(target: string) {
  const handlers: Record<string, Handler> = {};
  const cfg = devApiProxy(target)!['/api'];
  (cfg.configure as (p: unknown, o: unknown) => void)({ on: (e: string, h: Handler) => { handlers[e] = h; } }, cfg);
  return { cfg, res: (headers: Record<string, string[] | undefined>) => { const r = { headers }; (handlers.proxyRes as unknown as (r: unknown) => void)(r); return r.headers; }, req: (cookie: unknown) => { const h: Record<string, unknown> = { cookie }; (handlers.proxyReq as unknown as (r: unknown) => void)({ getHeader: (k: string) => h[k], setHeader: (k: string, v: unknown) => { h[k] = v; } }); return h.cookie; } };
}
const STAGING = 'https://dabi-orcamentos-staging.moyses-adm.workers.dev';

describe('Proxy de desenvolvimento do Vite', () => {
  it('sem alvo não há proxy (produção e build não são afetados)', () => { expect(devApiProxy(undefined)).toBeUndefined(); expect(devApiProxy('')).toBeUndefined(); });
  it('só aceita https (ou localhost) e URL válida', () => {
    expect(() => devApiProxy('http://api.exemplo.com')).toThrow();
    expect(() => devApiProxy('isto não é url')).toThrow();
    expect(devApiProxy('http://localhost:8787')).toBeDefined();
  });
  it('repassa só /api para a origem alvo, mantendo verificação de certificado', () => {
    const { cfg } = wire(STAGING);
    expect(cfg.target).toBe(STAGING); expect(cfg.secure).toBe(true); expect(cfg.changeOrigin).toBe(true);
    expect(Object.keys(devApiProxy(STAGING)!)).toEqual(['/api']);
  });
  it('Set-Cookie do servidor: remove __Host- e Secure (http local) e MANTÉM HttpOnly, SameSite=Lax, Path e Max-Age', () => {
    const { res } = wire(STAGING);
    const out = res({ 'set-cookie': ['__Host-dabi_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000; Secure'] })['set-cookie']![0];
    expect(out).toBe('dabi_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000');
    expect(out).toMatch(/HttpOnly/); expect(out).toMatch(/SameSite=Lax/); expect(out).not.toMatch(/Secure|__Host-|Domain/);
  });
  it('cookie de saída (logout) também é adaptado; respostas sem cookie passam intactas', () => {
    const { res } = wire(STAGING);
    expect(res({ 'set-cookie': ['__Host-dabi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'] })['set-cookie']![0]).toBe('dabi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(res({ 'content-type': ['application/json'] })['set-cookie']).toBeUndefined();
  });
  it('Cookie da requisição: dabi_session volta como __Host-dabi_session só para alvo https; outros cookies não mudam', () => {
    expect(wire(STAGING).req('dabi_session=abc; outro=1')).toBe('__Host-dabi_session=abc; outro=1');
    expect(wire(STAGING).req('outro=1; dabi_session=abc')).toBe('outro=1; __Host-dabi_session=abc');
    expect(wire(STAGING).req('outro=1')).toBe('outro=1');
    expect(wire(STAGING).req(undefined)).toBeUndefined();
    expect(wire('http://localhost:8787').req('dabi_session=abc')).toBe('dabi_session=abc'); // alvo http local usa o nome simples
  });
  it('não toca em Origin nem em CSRF (a proteção do servidor continua valendo integralmente)', () => {
    const cfg = devApiProxy(STAGING)!['/api'];
    expect(cfg).not.toHaveProperty('headers'); expect(cfg).not.toHaveProperty('cookieDomainRewrite'); expect(cfg).not.toHaveProperty('xfwd');
  });
});
