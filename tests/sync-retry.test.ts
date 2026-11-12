import { describe, expect, it } from 'vitest';
import { RETRY_BASE_MS, RETRY_MAX_MS, retryDelayMs } from '../src/sync/retry';

describe('retryDelayMs', () => {
  it('cresce de forma exponencial e respeita o teto', () => {
    const mid = () => 0.5;
    const d = [0, 1, 2, 3, 4, 5, 6, 10, 50].map(n => retryDelayMs(n, mid));
    expect(d[0]).toBe(RETRY_BASE_MS); expect(d[1]).toBe(RETRY_BASE_MS * 2); expect(d[2]).toBe(RETRY_BASE_MS * 4);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    expect(d.at(-1)).toBe(RETRY_MAX_MS);
  });
  it('a variação aleatória fica dentro de ±15% e nunca passa muito do teto', () => {
    expect(retryDelayMs(0, () => 0)).toBe(Math.round(RETRY_BASE_MS * 0.85));
    expect(retryDelayMs(0, () => 1)).toBe(Math.round(RETRY_BASE_MS * 1.15));
    expect(retryDelayMs(99, () => 1)).toBeLessThanOrEqual(RETRY_MAX_MS * 1.15);
  });
});
