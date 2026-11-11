import type { DataSet } from '../../src/domain/types';
import { createHttpSyncApi } from '../../src/sync/api';
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
  constructor(private server: Server, private session: Session) {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (this.offline) throw new TypeError('Failed to fetch');
      const isPush = String(url).endsWith('/api/sync/push');
      const res = await server.handle(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: this.status401 ? 'dabi_session=invalida' : session.cookie, origin: ORIGIN } }), server.env);
      if (isPush && this.dropNextPushResponse) { this.dropNextPushResponse = false; throw new TypeError('rede caiu depois do servidor gravar'); }
      return res;
    }) as typeof fetch;
    this.api = createHttpSyncApi({ baseUrl: BASE, getCsrfToken: () => session.csrf, fetchImpl });
  }
  edit(fn: (d: DataSet) => DataSet) { this.data = fn(this.data); }
  async sync(opts: { allowInitialMerge?: boolean } = {}) {
    const started = this.data;
    const r = await syncOnce(this.api, started, this.meta, opts);
    if (r.status === 'synced' || r.status === 'offline' || r.status === 'needs-attention' || r.status === 'error') { this.data = rebaseLocal(this.data, started, r.local); this.meta = r.meta; }
    return r;
  }
}
