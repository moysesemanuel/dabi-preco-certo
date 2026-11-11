// Gera dist/_headers (Cloudflare Pages) com a política de segurança do app. Roda depois do `vite build`.
// A única parte que depende do ambiente é a origem da API (VITE_API_URL), liberada em `connect-src`.
// Sem VITE_API_URL o app é local-only e a política não libera nenhum destino externo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const raw = process.env.VITE_API_URL ?? (existsSync('.env.production') ? /^VITE_API_URL=(.*)$/m.exec(readFileSync('.env.production', 'utf8'))?.[1] : '') ?? '';
let apiOrigin = '';
if (raw) {
  const u = new URL(raw.trim()); // lança se for inválida: o build falha em vez de publicar uma política errada
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('VITE_API_URL precisa ser https (ou localhost).');
  apiOrigin = u.origin;
}
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // o app usa atributos style inline do React; scripts continuam restritos a 'self'
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const headers = `# Gerado por scripts/generate-headers.mjs (não edite o arquivo em dist/).
/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin

# Arquivos com hash no nome nunca mudam: cache longo.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# A página e a configuração mudam a cada publicação: sempre revalidar.
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
`;
writeFileSync('dist/_headers', headers);
console.log(`dist/_headers gerado (connect-src: ${apiOrigin || "somente 'self'"}).`);
