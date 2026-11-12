/** Espera antes de nova tentativa após falha de rede/servidor: 5 s, 10 s, 20 s… até 2 min, com variação para não sincronizar vários aparelhos juntos. */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 120_000;
export function retryDelayMs(failureIndex: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failureIndex));
  return Math.round(base * (0.85 + 0.3 * random()));
}
/** Intervalo mínimo entre sincronizações disparadas por foco/visibilidade (normal e quando há falha em andamento). */
export const WAKE_MIN_INTERVAL_MS = 15_000;
export const WAKE_MIN_INTERVAL_FAILING_MS = 3_000;
