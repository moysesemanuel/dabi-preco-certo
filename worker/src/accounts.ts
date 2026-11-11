/** Primitivas criptográficas e regras das contas. Tudo com Web Crypto; nenhum protocolo próprio de autenticação. */
export const MAX_SESSIONS = 2;
/** A sessão vale por 30 dias de INATIVIDADE (cada uso a renova) e nunca passa de 90 dias desde o login: depois disso, novo código. */
export const SESSION_IDLE_DAYS = 30;
export const SESSION_MAX_DAYS = 90;
/** Cooldown entre pedidos de código para o mesmo e-mail: dentro dele não se envia outro (não invalida o anterior). */
export const CODE_RESEND_COOLDOWN_SECONDS = 60;
export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_DIGITS = 8;

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const toBase64Url = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}
/** Comparação em tempo constante (para códigos e tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Código numérico uniforme (amostragem por rejeição, sem viés de módulo). */
export function generateNumericCode(digits: number = CODE_DIGITS): string {
  const modulus = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / modulus) * modulus;
  const buf = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(buf); if (buf[0] < limit) return String(buf[0] % modulus).padStart(digits, '0'); }
}
export const randomToken = (bytes = 32): string => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
export const newUserId = () => `usr_${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
export const newSessionId = () => `ses_${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
export const newCodeId = () => `cod_${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;

/** E-mail em minúsculas, sem espaços, formato simples e tamanho limitado. A verificação real é o código enviado. */
export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || /[\u0000-\u001F\u007F\s,;<>()[\]\\"]/.test(email)) return undefined;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email) ? email : undefined;
}

export const normalizeDeviceLabel = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const label = raw.normalize('NFC').replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, 60);
  return label || null;
};

export const addMs = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
