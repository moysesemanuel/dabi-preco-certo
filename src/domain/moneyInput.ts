/** Parses BRL-like input while keeping a blank field distinct from numeric zero. */
export function parseMoneyInput(value: string): number | undefined {
  const source = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!source) return undefined;
  if (!/^-?[\d.,]+$/.test(source) || !/\d/.test(source)) return Number.NaN;

  const comma = source.lastIndexOf(',');
  const dot = source.lastIndexOf('.');
  let normalized: string;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    const integer = source.slice(0, source.lastIndexOf(decimal));
    const fraction = source.slice(source.lastIndexOf(decimal) + 1);
    if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(integer.replace(/^-/, '')).valueOf() || !/^\d*$/.test(fraction)) return Number.NaN;
    normalized = `${integer.replaceAll(grouping, '')}.${fraction}`;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.';
    const count = [...source].filter(c => c === separator).length;
    if (count > 1) {
      const parts = source.split(separator);
      if (!/^\d{1,3}$/.test(parts[0].replace(/^-/, '')) || parts.slice(1).some(p => p.length !== 3 || !/^\d+$/.test(p))) return Number.NaN;
      normalized = parts.join('');
      if (source.startsWith('-')) normalized = `-${normalized}`;
    } else {
      const [integer, fraction] = source.split(separator);
      if (!/^\d*$/.test(integer.replace(/^-/, '')) || !/^\d*$/.test(fraction) || fraction.length === 0) return Number.NaN;
      // A single separator followed by exactly three digits is ambiguous; treat it as a decimal
      // unless the leading group is exactly three digits and this is explicitly grouped elsewhere.
      normalized = `${integer}.${fraction}`;
    }
  } else normalized = source;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function formatMoneyInput(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
