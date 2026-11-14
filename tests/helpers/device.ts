import type { DataSet } from '../../src/domain/types';
import { upgradeOrderShape } from '../../shared/dataset';
import { createHttpSyncApi } from '../../src/sync/api';
import { resolveConflict, type ConflictAction } from '../../src/sync/resolve';
import { emptyDataSet, emptyMeta, rebaseLocal, syncOnce, type SyncApi, type SyncMeta } from '../../src/sync/engine';
import { BASE, ORIGIN, type Server, type Session } from './server';

/** Um dispositivo de teste: dados locais + metadados de sincronização + cliente HTTP ligado ao Worker real, com falhas de rede injetáveis. */
export class Device {
  data: DataSet = emptyDataSet();
  meta: SyncMeta = emptyMeta();
  offline = false;
  dropNextPushResponse = false;
  status401 = false;
  readonly api: SyncApi;
  /** `rewritePush`: altera o corpo dos envios antes de chegarem ao Worker (ex.: simular um Worker ANTIGO que descarta campos que não conhece). */
  constructor(private server: Server, private session: Session, rewritePush?: (body: Record<string, any>) => Record<string, any>) {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const isPush = String(url).endsWith('/api/sync/v2/push');
      if (isPush && rewritePush && typeof init.body === 'string') init = { ...init, body: JSON.stringify(rewritePush(JSON.parse(init.body))) };
      const res = await server.handle(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: this.status401 ? 'dabi_session=invalida' : session.cookie, origin: ORIGIN } }), server.env);
      if (isPush && this.dropNextPushResponse) { this.dropNextPushResponse = false; throw new TypeError('rede caiu depois do servidor gravar'); }
      return res;
    }) as typeof fetch;
    this.api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => session.csrf, fetchImpl });
  }
  /** Encomendas escritas nos testes no formato antigo (uma receita) passam pela mesma conversão que o app aplica ao ler o IndexedDB. */
  edit(fn: (d: DataSet) => DataSet) { const next = fn(this.data); this.data = { ...next, orders: next.orders.map(o => upgradeOrderShape(o) as DataSet['orders'][number]) }; }
  /** Decide um conflito como a interface faz (função pura do app) e atualiza os dados e o estado de sincronização do dispositivo. */
  resolve(conflictId: string, action: ConflictAction, expectedServerRev?: number) {
    const r = resolveConflict(this.data, this.meta, conflictId, action, new Date('2026-11-12T16:00:00Z'), expectedServerRev);
    this.data = r.data; this.meta = r.meta; return r.conflict;
  }
  async sync(opts: { allowInitialMerge?: boolean } = {}) {
    const started = this.data;
    const r = await syncOnce(this.api, started, this.meta, opts);
    if (r.status === 'synced' || r.status === 'offline' || r.status === 'needs-attention' || r.status === 'error') { this.data = rebaseLocal(this.data, started, r.local); this.meta = r.meta; }
    return r;
  }
}
