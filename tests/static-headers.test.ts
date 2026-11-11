import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/generate-headers.mjs');
function generate(apiUrl?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hdr-')); mkdirSync(join(dir, 'dist'));
  execFileSync('node', [script], { cwd: dir, env: { PATH: process.env.PATH ?? '', ...(apiUrl !== undefined ? { VITE_API_URL: apiUrl } : {}) }, stdio: 'pipe' });
  return readFileSync(join(dir, 'dist', '_headers'), 'utf8');
}
const csp = (h: string) => /Content-Security-Policy: (.*)/.exec(h)?.[1] ?? '';

describe('Cabeçalhos de segurança da hospedagem estática (Cloudflare Pages)', () => {
  it('política restritiva: scripts só do próprio site, sem iframes, sem plugins, sem base/forms externos', () => {
    const p = csp(generate());
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", 'upgrade-insecure-requests']) expect(p).toContain(d);
    expect(p).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(p).not.toContain('*');
  });
  it('sem VITE_API_URL (modo local) nenhum destino externo é liberado', () => {
    expect(csp(generate())).toContain("connect-src 'self';");
  });
  it('com VITE_API_URL libera exatamente a origem da API em connect-src (sem caminho)', () => {
    expect(csp(generate('https://api-hml.exemplo.com.br/qualquer/caminho'))).toContain("connect-src 'self' https://api-hml.exemplo.com.br;");
  });
  it('recusa API em http fora de localhost e URL inválida (o build falha em vez de publicar política errada)', () => {
    expect(() => generate('http://api.exemplo.com')).toThrow();
    expect(() => generate('isto não é url')).toThrow();
    expect(csp(generate('http://localhost:8787'))).toContain('http://localhost:8787');
  });
  it('inclui HSTS, nosniff, anti-clickjacking, referrer, permissões e cache seguro', () => {
    const h = generate();
    for (const x of ['Strict-Transport-Security: max-age=31536000', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy: no-referrer', 'Permissions-Policy: camera=()', 'Cross-Origin-Opener-Policy: same-origin']) expect(h).toContain(x);
    expect(h).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(h).toMatch(/\/index\.html\n {2}Cache-Control: no-cache/);
  });
});
