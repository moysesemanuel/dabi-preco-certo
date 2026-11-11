/**
 * Fila de gravação serializada. Garante que as gravações no IndexedDB acontecem UMA POR VEZ e em ordem:
 * uma gravação antiga e lenta nunca termina depois de uma nova e a sobrescreve.
 * Gravações pendentes são coalescidas: só o valor mais recente é gravado (o último vence).
 * `enqueue` resolve quando esse valor, ou um posterior, foi gravado; rejeita se a gravação que o cobre falhar.
 */
export function createSaveQueue<T>(save: (value: T) => Promise<void>) {
  let pending: { value: T } | null = null;
  let waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  let running = false;

  async function drain() {
    running = true;
    while (pending) {
      const { value } = pending;
      const batch = waiters;
      pending = null; waiters = [];
      try { await save(value); batch.forEach(w => w.resolve()); } catch (error) { batch.forEach(w => w.reject(error)); }
    }
    running = false;
  }

  return {
    enqueue(value: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        pending = { value };
        waiters.push({ resolve, reject });
        if (!running) void drain();
      });
    },
  };
}
