/**
 * Coordenação entre abas do mesmo navegador (mesma origem = mesmo IndexedDB).
 *
 * Regra: UMA aba edita por vez ("editor"); as demais ficam em modo de consulta ("viewer") e só leem.
 *  - Exclusão mútua: Web Locks API (`navigator.locks`). O navegador solta o bloqueio sozinho se a aba fechar, travar ou for descartada, e a aba
 *    que estava esperando assume automaticamente. Não depende de variáveis em memória nem de mensagens que podem se perder.
 *  - Notificação: BroadcastChannel avisa as abas em consulta que há dados novos no disco (se não existir, elas releem ao voltar o foco).
 *  - Rede de segurança: toda gravação compara a versão do documento dentro da transação do IndexedDB (`saveDataCas`), então mesmo sem Web Locks
 *    (navegador antigo) uma aba atrasada NUNCA apaga o que outra gravou: a gravação é recusada e a pessoa é avisada.
 * Nenhuma dessas operações usa a rede: custo zero para a Cloudflare.
 */
export type Role = 'pending' | 'editor' | 'viewer';
export type Handlers = { onRole(role: Role): void; onRemoteSaved(version: number): void };
type LockLike = { request(name: string, options: Record<string, unknown>, cb: (lock: unknown) => unknown): Promise<unknown>; };
type LockManagerLike = { request(name: string, ...args: unknown[]): Promise<unknown> };
type ChannelLike = { postMessage(m: unknown): void; close(): void; onmessage: ((e: { data: unknown }) => void) | null };

const LOCK_NAME = 'dabi-preco-certo:editor';
const CHANNEL_NAME = 'dabi-preco-certo:data';

export function createCoordinator(env: { locks?: LockManagerLike | null; channel?: () => ChannelLike | undefined } = {}) {
  const locks = ((env.locks !== undefined ? env.locks : typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockManagerLike }).locks : undefined) ?? undefined) as (LockManagerLike & LockLike) | undefined; // `null` = sem Web Locks (testes)
  const makeChannel = env.channel ?? (() => (typeof BroadcastChannel !== 'undefined' ? (new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike) : undefined));
  let handlers: Handlers | undefined, channel: ChannelLike | undefined, role: Role = 'pending';
  let release: (() => void) | undefined, waiting: AbortController | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined, started = false;

  const setRole = (r: Role) => { if (role !== r) { role = r; handlers?.onRole(r); } };
  /** Mantém o bloqueio até `release()` (ou até o navegador soltá-lo). */
  const hold = () => new Promise<void>(resolve => { release = () => { release = undefined; resolve(); }; setRole('editor'); });
  const lost = (e: unknown) => { release = undefined; if ((e as { name?: string } | undefined)?.name === 'AbortError' && started) { setRole('viewer'); queue(); } };

  /** Fica na fila: quando o editor atual fechar (ou soltar), esta aba assume sozinha. */
  function queue() {
    if (!locks || !started || waiting) return;
    const ctl = new AbortController(); waiting = ctl;
    locks.request(LOCK_NAME, { signal: ctl.signal }, () => { waiting = undefined; return hold(); }).catch(e => { if (waiting === ctl) waiting = undefined; if (!(e as { name?: string }).name?.includes('Abort') || started) lost(e); });
  }

  return {
    /** `true` se a exclusão mútua do navegador está disponível. Sem ela, só a rede de segurança (versão no IndexedDB) protege as gravações. */
    supported: !!locks,
    get role() { return role; },
    start(h: Handlers) {
      clearTimeout(stopTimer); handlers = h;
      if (started) { handlers.onRole(role); return; } // remontagem (StrictMode): mantém o estado
      started = true;
      channel = makeChannel(); if (channel) channel.onmessage = e => { const m = e.data as { type?: string; version?: number } | null; if (m?.type === 'saved' && typeof m.version === 'number') handlers?.onRemoteSaved(m.version); };
      if (!locks) { setRole('editor'); return; } // navegador sem Web Locks: segue em modo "editor" protegido pela versão do documento
      locks.request(LOCK_NAME, { ifAvailable: true }, (lock: unknown) => {
        if (!lock) { setRole('viewer'); queue(); return undefined; }
        return hold();
      }).catch(lost);
    },
    /** Assume a edição desta aba; a que estava editando passa a modo de consulta. */
    takeOver() {
      if (!locks || role === 'editor') return;
      waiting?.abort(); waiting = undefined;
      locks.request(LOCK_NAME, { steal: true }, () => hold()).catch(lost);
    },
    /** Avisa as outras abas que há uma versão nova no disco. */
    notifySaved(version: number) { try { channel?.postMessage({ type: 'saved', version }); } catch { /* canal fechado */ } },
    /** Soltar é adiado um instante: a remontagem imediata do React (StrictMode) cancela, sem perder o bloqueio. */
    stop() { clearTimeout(stopTimer); stopTimer = setTimeout(() => { started = false; waiting?.abort(); waiting = undefined; release?.(); channel?.close(); channel = undefined; role = 'pending'; }, 50); },
  };
}
export type Coordinator = ReturnType<typeof createCoordinator>;
