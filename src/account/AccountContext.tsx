import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataSet } from '../domain/types';
import { createQuotesClient, type QuotesClient } from '../features/sharing/quotes';
import { loadSyncMeta, saveSyncMeta } from '../storage/db';
import { createHttpSyncApi } from '../sync/api';
import { emptyDataSet, emptyMeta, isOpenFinancial, rebaseLocal, syncOnce, type ConflictRecord, type SyncMeta } from '../sync/engine';
import { reconcileFinancial, type ReconcileAction } from '../sync/reconcile';
import { createAuthClient, type AuthClient, type SessionInfo } from './authClient';
import { API_URL, safeApiBase } from './http';

export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'offline' | 'attention' | 'error';
export type SyncBlock = null | 'needs-decision' | 'account-mismatch';
export type SyncState = { phase: SyncPhase; message?: string; lastSyncedAt?: string; blocked: SyncBlock };
export type AccountStatus = 'unconfigured' | 'loading' | 'signed-out' | 'signed-in';

type Ctx = {
  status: AccountStatus;
  session?: SessionInfo;
  auth: AuthClient | null;
  quotes: QuotesClient | null;
  /** Licença ativa na conta: só então há sincronização e compartilhamento. */
  entitled: boolean;
  setSession(session: SessionInfo | undefined): void;
  signOut(): Promise<void>;
  sync: SyncState;
  syncNow(): Promise<void>;
  chooseMerge(): Promise<void>;
  adoptAccountData(): Promise<void>;
  conflicts: ConflictRecord[];
  /** Remove os avisos já tratados. Pendências FINANCEIRAS sem decisão nunca são dispensadas. */
  dismissConflicts(): void;
  /** Resolve uma pendência financeira. Lança Error com a explicação se a regra de negócio impedir (ex.: passaria do total). */
  resolveFinancial(conflictId: string, action: ReconcileAction): void;
  openFinancial: number;
};
const AccountCtx = createContext<Ctx | null>(null);
export const useAccount = (): Ctx => { const c = useContext(AccountCtx); if (!c) throw new Error('useAccount fora do AccountProvider'); return c; };

type Props = { data: DataSet; setData: (fn: (d: DataSet) => DataSet) => void; ready: boolean; children: ReactNode };
const DEBOUNCE_MS = 2500;

/**
 * Conta + sincronização. O app continua 100% local sem conta. Com conta e licença ativa, o servidor é a fonte autoritativa
 * e o IndexedDB é o cache. Regras de segurança dos dados: nunca sincroniza antes de carregar os dados locais, nunca mistura
 * contas diferentes no mesmo dispositivo sem decisão do usuário e nunca apaga dados locais sem confirmação.
 */
export function AccountProvider({ data, setData, ready, children }: Props) {
  const base = safeApiBase(API_URL);
  const auth = useMemo(() => (base ? createAuthClient(base) : null), [base]);
  const csrfRef = useRef<string | undefined>(undefined);
  const quotes = useMemo(() => (base ? createQuotesClient(base, () => csrfRef.current) : null), [base]);
  const [status, setStatus] = useState<AccountStatus>(base ? 'loading' : 'unconfigured');
  const [session, setSessionState] = useState<SessionInfo | undefined>();
  const [sync, setSync] = useState<SyncState>({ phase: 'idle', blocked: null });
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);

  const dataRef = useRef(data); dataRef.current = data;
  const metaRef = useRef<SyncMeta | null>(null); // null = ainda não carregado: não sincroniza
  const lastApplied = useRef<DataSet | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const blockedRef = useRef<SyncBlock>(null);
  const sessionRef = useRef<SessionInfo | undefined>(undefined);
  sessionRef.current = session;

  const setSession = useCallback((s: SessionInfo | undefined) => { csrfRef.current = s?.csrfToken; setSessionState(s); setStatus(s ? 'signed-in' : 'signed-out'); }, []);
  const entitled = status === 'signed-in' && session?.license?.status === 'active';

  useEffect(() => { loadSyncMeta().then(m => { metaRef.current = m; setConflicts(m.conflicts); }).catch(() => { metaRef.current = emptyMeta(); }); }, []);
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    auth.currentSession().then(r => { if (alive) setSession(r.ok ? r.value : undefined); });
    return () => { alive = false; };
  }, [auth, setSession]);

  const block = (b: SyncBlock, message?: string) => { blockedRef.current = b; setSync(s => ({ ...s, blocked: b, phase: b ? 'attention' : s.phase, message })); };

  const run = useCallback(async (opts: { allowInitialMerge?: boolean } = {}) => {
    const sess = sessionRef.current;
    if (!base || !sess || sess.license?.status !== 'active' || !metaRef.current) return;
    if (running.current) { again.current = true; return; }
    if (blockedRef.current && !opts.allowInitialMerge) return;
    running.current = true;
    setSync(s => ({ ...s, phase: 'syncing', message: undefined }));
    try {
      let meta = metaRef.current;
      if (meta.userId && meta.userId !== sess.user.id) { block('account-mismatch', 'Este dispositivo tem dados de outra conta.'); return; }
      const started = dataRef.current;
      const api = createHttpSyncApi({ baseUrl: base, getCsrfToken: () => csrfRef.current });
      const r = await syncOnce(api, started, meta, opts);
      if (r.status === 'needs-decision') { block('needs-decision', r.message); return; }
      if (r.status !== 'unauthorized' && r.status !== 'forbidden') {
        meta = { ...r.meta, userId: sess.user.id };
        metaRef.current = meta; setConflicts(meta.conflicts);
        setData(cur => { const next = rebaseLocal(cur, started, r.local); lastApplied.current = next; return next; });
        await saveSyncMeta(meta).catch(() => undefined);
      }
      if (r.status === 'unauthorized') { setSession(undefined); setSync({ phase: 'idle', blocked: null }); return; }
      if (r.status === 'forbidden') {
        // Licença revogada (ou conta sem licença): relê a sessão para o app refletir a perda do direito. Os dados locais ficam intactos.
        const cur = await auth?.currentSession();
        if (cur?.ok) setSession(cur.value); else if (cur && cur.reason === 'unauthorized') setSession(undefined);
        setSync({ phase: 'attention', message: r.message, blocked: null });
        return;
      }
      blockedRef.current = null;
      const pendingMoney = meta.conflicts.filter(isOpenFinancial).length;
      if (pendingMoney > 0 && r.status === 'synced') { setSync({ phase: 'attention', message: 'Há recebimentos aguardando a sua reconciliação (veja em Configurações).', lastSyncedAt: new Date().toISOString(), blocked: null }); return; }
      setSync({ phase: r.status === 'synced' ? 'synced' : r.status === 'offline' ? 'offline' : r.status === 'needs-attention' ? 'attention' : 'error', message: r.status === 'synced' ? undefined : r.message, lastSyncedAt: r.status === 'synced' ? new Date().toISOString() : undefined, blocked: null });
    } finally {
      running.current = false;
      if (again.current) { again.current = false; void run(); }
    }
  }, [base, auth, setData, setSession]);

  // Sincroniza ao entrar, depois de mudanças locais (com pausa) e quando a internet volta.
  useEffect(() => { if (entitled && ready) void run(); }, [entitled, ready, run]);
  useEffect(() => {
    if (!entitled || !ready || data === lastApplied.current) return;
    const t = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [data, entitled, ready, run]);
  useEffect(() => {
    if (!entitled || !ready) return;
    const onOnline = () => void run();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [entitled, ready, run]);

  const value: Ctx = {
    status, session, auth, quotes, entitled, setSession,
    async signOut() { if (auth && csrfRef.current) await auth.logout(csrfRef.current); setSession(undefined); setSync({ phase: 'idle', blocked: null }); blockedRef.current = null; },
    sync, syncNow: () => run(),
    async chooseMerge() { blockedRef.current = null; setSync(s => ({ ...s, blocked: null })); await run({ allowInitialMerge: true }); },
    /** Troca os dados deste dispositivo pelos da conta (a tela pede confirmação e sugere backup antes). */
    async adoptAccountData() {
      const sess = sessionRef.current; if (!sess) return;
      blockedRef.current = null;
      metaRef.current = { ...emptyMeta(), userId: sess.user.id };
      await saveSyncMeta(metaRef.current).catch(() => undefined);
      setData(() => { const next = emptyDataSet(); lastApplied.current = next; return next; });
      dataRef.current = emptyDataSet();
      setSync(s => ({ ...s, blocked: null }));
      await run();
    },
    conflicts,
    dismissConflicts() {
      if (!metaRef.current) return;
      const kept = metaRef.current.conflicts.filter(isOpenFinancial); // dinheiro pendente nunca some em silêncio
      metaRef.current = { ...metaRef.current, conflicts: kept }; void saveSyncMeta(metaRef.current).catch(() => undefined); setConflicts(kept);
    },
    openFinancial: conflicts.filter(isOpenFinancial).length,
    resolveFinancial(conflictId, action) {
      const meta = metaRef.current; const c = meta?.conflicts.find(x => x.id === conflictId);
      if (!meta || !c) throw new Error('Pendência não encontrada.');
      const now = new Date(), copyId = crypto.randomUUID();
      const res = reconcileFinancial(dataRef.current, c, action, now, () => copyId); // lança se a regra impedir; nada é alterado antes disso
      setData(cur => { try { return reconcileFinancial(cur, c, action, now, () => copyId).data; } catch { return cur; } });
      const nextMeta = { ...meta, conflicts: meta.conflicts.map(x => (x.id === conflictId ? res.conflict : x)) };
      metaRef.current = nextMeta; setConflicts(nextMeta.conflicts); void saveSyncMeta(nextMeta).catch(() => undefined);
    },
  };
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}
