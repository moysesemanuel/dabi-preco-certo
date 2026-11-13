/** Limites e validação de valores monetários (em reais) e quantidades. */
export const MAX_MONEY = 1_000_000_000;
export const MAX_QUANTITY = 1_000_000_000;

/** Número finito entre 0 e R$ 1 bilhão. Rejeita NaN, Infinity, negativos e texto. */
export const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY;
/** Quantia monetária já normalizada para precisão de centavos. */
export const isCentMoney = (v: unknown): v is number => isMoney(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
export const isPositiveQuantity = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_QUANTITY;
/** Arredonda para centavos ao gravar valores digitados (ex.: 6,999 → 7,00). */
export const toCents2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
