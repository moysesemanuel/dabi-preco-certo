import { LICENSE_KEY_PREFIX } from '../../shared/licenseKey.ts';

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** Gera uma chave com 192 bits de entropia (Web Crypto). Mostre-a UMA vez, na emissão; ela nunca é armazenada. */
export function generateLicenseKey(): string {
  return LICENSE_KEY_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** Identificador interno do proprietário (não é segredo; aparece em `quotes.owner_id`). */
export function generateLicenseId(): string {
  return `lic_${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
}
export const LICENSE_ID_PATTERN = /^lic_[0-9a-f]{16}$/;

/**
 * Verificador armazenado no D1: SHA-256 (hex) da chave. Como a chave é aleatória e de alta entropia (192 bits),
 * um digest simples é suficiente; não há senha de baixa entropia a proteger com KDF lento.
 */
export async function hashLicenseKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return toHex(new Uint8Array(digest));
}
export const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/;
