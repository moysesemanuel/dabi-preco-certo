const VULGAR: Record<string, number> = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
const DECIMAL = /^\d+(?:[.,]\d+)?$|^[.,]\d+$/;

const decimal = (t: string): number | undefined => (DECIMAL.test(t) ? Number(t.replace(',', '.')) : undefined);
const fraction = (t: string): number | undefined => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(t); if (!m) return undefined;
  const d = Number(m[2]); return d === 0 ? undefined : Number(m[1]) / d;
};

/**
 * Lê uma quantidade digitada: inteiros, decimais com vírgula ou ponto ("2,5"), frações ("1/2"), números mistos ("1 1/2")
 * e frações unicode ("½", "1½", "1 ½"). Devolve undefined quando o texto não é uma quantidade válida (nunca adivinha).
 * Não aceita separador de milhar nem números negativos.
 */
export function parseQuantity(input: string): number | undefined {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  const v = decimal(t) ?? fraction(t) ?? ((): number | undefined => {
    const last = t.slice(-1);
    if (last in VULGAR) { const head = t.slice(0, -1).trim(); const whole = head === '' ? 0 : decimal(head); return whole === undefined || (head.includes(',') || head.includes('.')) ? undefined : whole + VULGAR[last]; }
    const mixed = /^(\d+) (\d+\s*\/\s*\d+)$/.exec(t); if (mixed) { const f = fraction(mixed[2]); return f === undefined ? undefined : Number(mixed[1]) + f; }
    return undefined;
  })();
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}
