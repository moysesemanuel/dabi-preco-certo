/**
 * Simulador da Web Locks API (navigator.locks) com a semântica que importa para a coordenação entre abas:
 * exclusivo, fila FIFO, `ifAvailable`, `steal` (o dono anterior recebe AbortError), `signal` e liberação automática quando a aba "fecha".
 * Cada aba recebe uma visão própria (`forTab`) do MESMO gerenciador, como no navegador. A validação com o navegador REAL é feita à parte (Chrome).
 */
type Opts = { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal; mode?: string };
type Holder = { tab: string; reject: (e: unknown) => void };
type Waiter = { tab: string; run: () => void; dead: boolean };
const abortError = (msg: string) => Object.assign(new Error(msg), { name: 'AbortError' });

export function createFakeLocks() {
  const held = new Map<string, Holder>(); const queues = new Map<string, Waiter[]>();
  const grant = (name: string) => { const q = queues.get(name) ?? []; while (q.length && !held.has(name)) { const w = q.shift()!; if (!w.dead) w.run(); } };
  function request(tab: string, name: string, a: Opts | ((lock: unknown) => unknown), b?: (lock: unknown) => unknown): Promise<unknown> {
    const options: Opts = typeof a === 'function' ? {} : a; const cb = (typeof a === 'function' ? a : b)!;
    return new Promise((resolve, reject) => {
      const run = () => {
        const entry: Holder = { tab, reject }; held.set(name, entry);
        // O bloqueio vale até a promessa devolvida pelo callback terminar (como no navegador).
        Promise.resolve().then(() => cb({ name })).then(
          v => { if (held.get(name) === entry) { held.delete(name); resolve(v); grant(name); } },
          e => { if (held.get(name) === entry) { held.delete(name); reject(e); grant(name); } });
      };
      if (options.signal?.aborted) return reject(abortError('aborted'));
      if (options.ifAvailable) { if (held.has(name)) { Promise.resolve().then(() => cb(null)).then(resolve, reject); return; } return run(); }
      if (options.steal) { const cur = held.get(name); if (cur) { held.delete(name); cur.reject(abortError('lock stolen')); } return run(); } // o dono anterior recebe AbortError
      if (!held.has(name)) return run();
      const w: Waiter = { tab, run, dead: false };
      (queues.get(name) ?? queues.set(name, []).get(name)!).push(w);
      options.signal?.addEventListener('abort', () => { w.dead = true; reject(abortError('aborted')); });
    });
  }
  return {
    forTab: (tab: string) => ({ request: (name: string, a: Opts | ((l: unknown) => unknown), b?: (l: unknown) => unknown) => request(tab, name, a, b) }),
    /** A aba fechou/travou/foi descartada: o navegador solta os bloqueios dela e remove as esperas. */
    closeTab(tab: string) { for (const [name, h] of [...held]) if (h.tab === tab) { held.delete(name); grant(name); } for (const q of queues.values()) q.forEach(w => { if (w.tab === tab) w.dead = true; }); },
    holder: (name: string) => held.get(name)?.tab,
  };
}

/** BroadcastChannel simulado: entrega a OUTRAS instâncias do mesmo nome (como o navegador). */
export function createFakeBroadcast() {
  const all = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) { (all.get(name) ?? all.set(name, new Set()).get(name)!).add(this); }
    postMessage(data: unknown) { for (const c of all.get(this.name) ?? []) if (c !== this) queueMicrotask(() => c.onmessage?.({ data })); }
    close() { all.get(this.name)?.delete(this); }
  }
  return FakeChannel;
}
