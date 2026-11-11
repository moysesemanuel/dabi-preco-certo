/**
 * Formato da chave de licença (compartilhado entre Worker, CLI administrativo e app).
 * A chave é um segredo: nunca vai em URL, log, resposta de erro nem dados públicos do orçamento.
 * Aqui só há constantes e validação de formato (sem criptografia).
 */
export const LICENSE_KEY_PREFIX = 'dabi_lic_';
/** 24 bytes aleatórios (192 bits) em base64url = 32 caracteres. */
export const LICENSE_KEY_PATTERN = /^dabi_lic_[A-Za-z0-9_-]{32}$/;

export const isLicenseKeyFormat = (value: unknown): value is string => typeof value === 'string' && LICENSE_KEY_PATTERN.test(value);

/** Extrai a chave de `Authorization: Bearer <chave>`. Devolve undefined se ausente ou malformado. */
export function parseBearer(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return m && isLicenseKeyFormat(m[1]) ? m[1] : undefined;
}
