import { describe, expect, it } from 'vitest';
import { createSaveQueue } from '../src/storage/saveQueue';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Fila de gravação serializada', () => {
  it('grava uma por vez e em ordem; o último valor vence', async () => {
    const log: string[] = [];
    let active = 0, maxActive = 0;
    const q = createSaveQueue<number>(async v => { active++; maxActive = Math.max(maxActive, active); log.push(`início ${v}`); await sleep(v === 1 ? 30 : 5); log.push(`fim ${v}`); active--; });
    await Promise.all([1, 2, 3, 4, 5].map(v => q.enqueue(v)));
    expect(maxActive).toBe(1);
    // 1 está em andamento; 2, 3 e 4 são coalescidos; só 5 é gravado depois
    expect(log).toEqual(['início 1', 'fim 1', 'início 5', 'fim 5']);
  });
  it('uma gravação lenta e antiga NUNCA termina depois (nem sobrescreve) uma nova', async () => {
    const storage: { value: number | null; history: number[] } = { value: null, history: [] };
    const delays = [40, 1, 25, 1, 10, 1];
    let call = 0;
    const q = createSaveQueue<number>(async v => { await sleep(delays[call++ % delays.length]); storage.value = v; storage.history.push(v); });
    const writes: Promise<void>[] = [];
    for (let v = 1; v <= 30; v++) { writes.push(q.enqueue(v)); if (v % 7 === 0) await sleep(15); }
    await Promise.all(writes);
    expect(storage.value).toBe(30);
    expect(storage.history).toEqual([...storage.history].sort((a, b) => a - b)); // nunca uma versão antiga depois de uma nova
  });
  it('cada enqueue só resolve depois que seu valor (ou um mais novo) foi gravado', async () => {
    const saved: number[] = [];
    const q = createSaveQueue<number>(async v => { await sleep(10); saved.push(v); });
    const a = q.enqueue(1);
    const b = q.enqueue(2);
    await a;
    expect(saved).toContain(1);
    await b;
    expect(saved[saved.length - 1]).toBe(2);
  });
  it('falha na gravação rejeita quem dependia dela, mas a fila continua funcionando', async () => {
    let fail = true; const saved: number[] = [];
    const q = createSaveQueue<number>(async v => { await sleep(2); if (fail) throw new Error('disco cheio'); saved.push(v); });
    await expect(q.enqueue(1)).rejects.toThrow('disco cheio');
    fail = false;
    await q.enqueue(2);
    expect(saved).toEqual([2]);
  });
  it('uma falha não descarta um valor mais novo que estava na espera', async () => {
    const attempts: number[] = []; let n = 0;
    const q = createSaveQueue<number>(async v => { attempts.push(v); await sleep(10); if (n++ === 0) throw new Error('falha'); });
    const first = q.enqueue(1).catch(() => 'falhou');
    const second = q.enqueue(2);
    expect(await first).toBe('falhou');
    await second;
    expect(attempts).toEqual([1, 2]);
  });
  it('sob carga aleatória, o estado final é sempre o último valor enfileirado', async () => {
    for (let round = 0; round < 20; round++) {
      let stored = -1; const q = createSaveQueue<number>(async v => { await sleep(Math.floor(Math.random() * 6)); stored = v; });
      const writes: Promise<void>[] = [];
      for (let v = 0; v < 25; v++) { writes.push(q.enqueue(v)); if (Math.random() < 0.3) await sleep(Math.floor(Math.random() * 4)); }
      await Promise.all(writes);
      expect(stored).toBe(24);
    }
  });
});
