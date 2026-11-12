import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataSet } from '../domain/types';
import { createQuotesClient, type QuotesClient } from '../features/sharing/quotes';
import { loadSyncMeta, saveSyncMeta } from '../storage/db';
import { createHttpSyncApi } from '../sync/api';
import { buildPushes, emptyDataSet, emptyMeta, isOpenFinancial, isPendingConflict, isUnresolved, rebaseLocal, syncOnce, type ConflictRecord, type SyncMeta } from '../sync/engine';
import { DEBOUNCE_MS, retryDelayMs, WAKE_MIN_INTERVAL_MS, WAKE_MIN_INTERVAL_FAILING_MS } from '../sync/retry';
import { resolveConflict as resolveConflictPure, type ConflictAction } from '../sync/resolve';
import { reconcileFinancial, type ReconcileAction } from '../sync/reconcile';
import { AUTH_MESSAGES, createAuthClient, type AuthClient, type SessionInfo } from './authClient';
import { API_URL, REQUIRE_LOGIN, safeApiBase } from './http';

export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'offline' | 'attention' | 'error';
export type SyncBlock = null | 'needs-decision' | 'account-mismatch';
export type SyncState = { phase: SyncPhase; message?: string; /** Última confirmação REMOTA bem-sucedida (preservada durante falhas). */ lastSyncedAt?: string; /** Quando a falha atual começou; some na próxima confirmação. */ failingSince?: string; blocked: SyncBlock };
export type AccountStatus = 'unconfigured' | 'loading' | 'signed-out' | 'signed-in';
/** Se o app pode ser usado agora. Fora da versão comercial (`REQUIRE_LOGIN`) é sempre 'open'. */
export type Access = 'open' | 'checking' | 'login' | 'inactive' | 'offline-grace';
const LAST_ACCESS_KEY = 'pedidocerto.lastAccess';
/** Sem internet, quem já entrou antes pode seguir usando os dados deste dispositivo por até 7 dias desde a última verificação. */
export const OFFLINE_GRACE_MS = 7 * 86_400_000;
const readLastAccess = (): number | undefined => { try { const v = Number(localStorage.getItem(LAST_ACCESS_KEY)); return Number.isFinite(v) && v > 0 ? v : undefined; } catch { return undefined; } };
const writeLastAccess = (v: number | undefined) => { try { if (v === undefined) localStorage.removeItem(LAST_ACCESS_KEY); else localStorage.setItem(LAST_ACCESS_KEY, String(v)); } catch { /* sem armazenamento: só perde a tolerância offline */ } };

export type SignOutResult = { ok: true } | { ok: false; message: string };

type Ctx = {
  status: AccountStatus;
  session?: SessionInfo;
  auth: AuthClient | null;
  quotes: QuotesClient | null;
  /** Licença ativa na conta: só então há sincronização e compartilhamento. */
  entitled: boolean;
  /** Versão comercial: se o app pode ser usado (login + licença ativa, ou tolerância offline). */
  access: Access;
  requireLogin: boolean;
  setSession(session: SessionInfo | undefined): void;
  /** Só encerra a sessão local depois que o servidor confirma (200/401). Falha de rede ou do servidor: continua conectado e devolve a mensagem. */
  signOut(): Promise<SignOutResult>;
  sync: SyncState;
  syncNow(): Promise<void>;
  chooseMerge(): Promise<void>;
  adoptAccountData(): Promise<void>;
  /** Aviso a mostrar na tela de entrada quando a sessão foi perdida (por exemplo, o servidor não reconheceu o cookie). */
  authNotice: string;
  conflicts: ConflictRecord[];
  /** Remove os avisos já tratados. Pendências FINANCEIRAS sem decisão nunca são dispensadas. */
  dismissConflicts(): void;
  /** Resolve uma pendência financeira. Lança Error com a explicação se a regra de negócio impedir (ex.: passaria do total). */
  resolveFinancial(conflictId: string, action: ReconcileAction): void;
  openFinancial: number;
  /** Conflitos de dados aguardando decisão (derivado do estado persistido; some só quando resolvido). */
  pendingConflicts: ConflictRecord[];
  /** Mantém a versão daqui ou a da nuvem. `expectedServerRev` evita decidir sobre uma comparação desatualizada. Lança Error se a regra impedir. */
  resolveConflict(conflictId: string, action: ConflictAction, expectedServerRev?: number): void;
  conflictsOpen: boolean;
  setConflictsOpen(open: boolean): void;
  /** Há alteração local ainda não confirmada pelo servidor (comparação com a última versão confirmada, guardada no IndexedDB). */
  hasPending: boolean;
};
const AccountCtx = createContext<Ctx | null>(null);
export const useAccount = (): Ctx => { const c = useContext(AccountCtx); if (!c) throw new Error('useAccount fora do AccountProvider'); return c; };

type Props = { data: DataSet; setData: (fn: (d: DataSet) => DataSet) => void; ready: boolean; /** Muda quando esta aba assume a edição: a sessão é verificada de novo antes de qualquer sincronização. */ epoch?: number; /** Muda quando outra aba gravou: o estado de sincronização é relido do disco. */ metaVersion?: number; children: ReactNode; /** Padrão: VITE_REQUIRE_LOGIN. Existe para testes. */ requireLogin?: boolean };

/**
 * Conta + sincronização. O app continua 100% local sem conta. Com conta e licença ativa, o servidor é a fonte autoritativa
 * e o IndexedDB é o cache. Regras de segurança dos dados: nunca sincroniza antes de carregar os dados locais, nunca mistura
 * contas diferentes no mesmo dispositivo sem decisão do usuário e nunca apaga dados locais sem confirmação.
 */
export function AccountProvider({ data, setData, ready: readyProp, epoch = 0, metaVersion = 0, children, requireLogin = REQUIRE_LOGIN }: Props) {
  // Depois de assumir a edição, a sincronização só começa quando a sessão (cookie, compartilhado entre abas) foi verificada de novo: uma aba que ficou
  // em consulta pode estar com uma identidade antiga, e sincronizar com ela poderia misturar dados de contas.
  const [verified, setVerified] = useState(0);
  const ready = readyProp && verified === epoch;
  const base = safeApiBase(API_URL);
  const auth = useMemo(() => (base ? createAuthClient(base) : null), [base]);
  const csrfRef = useRef<string | undefined>(undefined);
  const quotes = useMemo(() => (base ? createQuotesClient(base, () => csrfRef.current) : null), [base]);
  const [status, setStatus] = useState<AccountStatus>(base ? 'loading' : 'unconfigured');
  const [session, setSessionState] = useState<SessionInfo | undefined>();
  const [sync, setSync] = useState<SyncState>({ phase: 'idle', blocked: null });
  const [networkDown, setNetworkDown] = useState(false);
  const networkDownRef = useRef(false); networkDownRef.current = networkDown;
  const [authNotice, setAuthNotice] = useState('');
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictState, setConflictState] = useState<{ list: ConflictRecord[]; owner?: string }>({ list: [] });

  const dataRef = useRef(data); dataRef.current = data;
  const metaRef = useRef<SyncMeta | null>(null); // null = ainda não carregado: não sincroniza
  // Estados de dados produzidos pelo próprio app (resultado de uma sincronização, resolução de conflito ou troca de conta): NÃO são edições do usuário
  // e não devem disparar uma nova sincronização. Um WeakSet identifica o OBJETO, então não depende de quantas vezes o React chama a função de
  // atualização (em desenvolvimento, com StrictMode, ela roda duas vezes e uma referência única "do último resultado" ficava diferente do estado,
  // o que reagendava a sincronização a cada 2,5 s, para sempre).
  const appProduced = useRef(new WeakSet<DataSet>());
  const seeded = useRef(false);
  const setConflicts = (list: ConflictRecord[]) => setConflictState({ list, owner: metaRef.current?.userId });
  const running = useRef(false);
  const again = useRef(false);
  const blockedRef = useRef<SyncBlock>(null);
  const failures = useRef(0);
  const lastRunAt = useRef(0);
  const syncRef = useRef<SyncState>({ phase: 'idle', blocked: null });
  const sessionRef = useRef<SessionInfo | undefined>(undefined);
  sessionRef.current = session;
  syncRef.current = sync;

  const setSession = useCallback((s: SessionInfo | undefined) => { if (s) setAuthNotice(''); csrfRef.current = s?.csrfToken; setSessionState(s); setStatus(s ? 'signed-in' : 'signed-out'); }, []);
  const entitled = status === 'signed-in' && session?.license?.status === 'active';
  // Conflitos só aparecem para a conta a que pertencem (nunca os de outra conta guardados neste aparelho).
  const conflicts = status === 'signed-in' && session && (!conflictState.owner || conflictState.owner === session.user.id) ? conflictState.list : [];
  const pendingConflicts = conflicts.filter(isPendingConflict);

  useEffect(() => { loadSyncMeta().then(m => { metaRef.current = m; setConflicts(m.conflicts); }).catch(() => { metaRef.current = emptyMeta(); }); }, [metaVersion]);
  useEffect(() => { if (epoch > 0) { setSync({ phase: 'idle', blocked: null }); blockedRef.current = null; failures.current = 0; } }, [epoch]);
  useEffect(() => {
    if (!auth) { setVerified(epoch); return; }
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, tries = 0;
    const check = (): Promise<void> => auth.currentSession().then(r => {
      if (!alive) return;
      const down = !r.ok && r.reason === 'network';
      setNetworkDown(down);
      setSession(r.ok ? r.value : undefined);
      setVerified(epoch);
      // Sem rede ao abrir: confirma a sessão de novo sozinho (com espera crescente), sem depender do evento `online`.
      clearTimeout(timer);
      if (down) timer = setTimeout(() => { void check(); }, retryDelayMs(tries++)); else tries = 0;
    });
    void check();
    const again = () => { if (alive && document.visibilityState !== 'hidden') void check(); };
    const onOnline = () => { void check(); }; // volta a internet: confirma o acesso de verdade
    window.addEventListener('online', onOnline);
    const onWake = () => { if (networkDownRef.current) again(); };
    window.addEventListener('focus', onWake); document.addEventListener('visibilitychange', onWake);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('online', onOnline); window.removeEventListener('focus', onWake); document.removeEventListener('visibilitychange', onWake); };
  }, [auth, setSession, epoch]);
  // Registra o último acesso verificado (só a hora; nenhum dado pessoal) para a tolerância offline.
  useEffect(() => { if (entitled) writeLastAccess(Date.now()); }, [entitled]);
  const access: Access = !requireLogin ? 'open'
    : status === 'loading' ? 'checking'
    : entitled ? 'open'
    : status === 'signed-in' ? 'inactive'
    : networkDown && (readLastAccess() ?? 0) > Date.now() - OFFLINE_GRACE_MS ? 'offline-grace'
    : 'login';

  const block = (b: SyncBlock, message?: string) => { blockedRef.current = b; setSync(s => ({ ...s, blocked: b, phase: b ? 'attention' : s.phase, message })); };

  const run = useCallback(async (opts: { allowInitialMerge?: boolean } = {}) => {
    const sess = sessionRef.current;
    if (!base || !sess || sess.license?.status !== 'active' || !metaRef.current) return;
    if (running.current) { again.current = true; return; }
    if (blockedRef.current && !opts.allowInitialMerge) return;
    running.current = true; lastRunAt.current = Date.now();
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
        setData(cur => { const next = rebaseLocal(cur, started, r.local); appProduced.current.add(next); return next; });
        await saveSyncMeta(meta).catch(() => undefined);
      }
      if (r.status === 'unauthorized') { setSession(undefined); setAuthNotice('Sua sessão não foi reconhecida pelo servidor (expirou, foi encerrada ou o navegador não enviou o cookie). Entre novamente.'); setSync({ phase: 'idle', blocked: null }); return; }
      if (r.status === 'forbidden') {
        // Licença revogada (ou conta sem licença): relê a sessão para o app refletir a perda do direito. Os dados locais ficam intactos.
        const cur = await auth?.currentSession();
        if (cur?.ok && cur.value.user.id !== sess.user.id) {
          // Outra aba saiu e entrou com OUTRA conta neste navegador: esta aba não assume a identidade nova em silêncio (os dados locais continuam intactos).
          setSession(undefined); setAuthNotice('A conta usada neste navegador mudou em outra aba. Entre de novo para continuar.'); setSync({ phase: 'idle', blocked: null }); return;
        }
        if (cur?.ok) setSession(cur.value); else if (cur && cur.reason === 'unauthorized') setSession(undefined);
        setSync(s => ({ ...s, phase: 'attention', message: r.message, blocked: null }));
        return;
      }
      blockedRef.current = null;
      const waiting = meta.conflicts.filter(isPendingConflict).length, pendingMoney = meta.conflicts.filter(isOpenFinancial).length;
      if (waiting + pendingMoney > 0 && r.status === 'synced') {
        failures.current = 0;
        setSync({ phase: 'attention', message: waiting ? 'Há alterações diferentes aguardando a sua decisão.' : 'Há recebimentos aguardando a sua reconciliação (veja em Configurações).', lastSyncedAt: new Date().toISOString(), blocked: null });
        return;
      }
      const ok = r.status === 'synced';
      const transient = r.status === 'offline' || r.status === 'error';
      failures.current = ok ? 0 : transient ? failures.current + 1 : failures.current;
      const nowIso = new Date().toISOString();
      setSync(s => ({
        phase: ok ? 'synced' : r.status === 'offline' ? 'offline' : r.status === 'needs-attention' ? 'attention' : 'error',
        message: ok ? undefined : r.message,
        // A confirmação remota anterior é preservada durante falhas (para o horário no aviso); só uma nova confirmação a substitui.
        lastSyncedAt: ok ? nowIso : s.lastSyncedAt,
        failingSince: ok ? undefined : s.failingSince ?? nowIso,
        blocked: null,
      }));
    } finally {
      running.current = false;
      if (again.current) { again.current = false; void run(); }
    }
  }, [base, auth, setData, setSession]);

  // Sincroniza ao entrar, depois de mudanças locais (com pausa) e quando a internet volta.
  useEffect(() => { if (entitled && ready) void run(); }, [entitled, ready, run]);
  useEffect(() => { if (ready && !seeded.current) { seeded.current = true; appProduced.current.add(data); } }, [ready, data]); // o que veio do disco não é edição (a sincronização de entrada já cuida dele)
  useEffect(() => {
    if (!entitled || !ready || appProduced.current.has(data) || !seeded.current) return;
    const t = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [data, entitled, ready, run]);
  useEffect(() => {
    if (!entitled || !ready) return;
    const onOnline = () => void run();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [entitled, ready, run]);

  // Nova tentativa automática depois de falha de rede/servidor, com espera crescente (não depende do evento `online`,
  // que o navegador nem sempre emite — por exemplo ao sair de "Offline" nas ferramentas de desenvolvedor).
  useEffect(() => {
    if (!entitled || !ready || sync.blocked || (sync.phase !== 'offline' && sync.phase !== 'error')) return;
    const t = setTimeout(() => void run(), retryDelayMs(Math.max(0, failures.current - 1)));
    return () => clearTimeout(t);
  }, [sync.phase, sync.blocked, entitled, ready, run]);
  // Ao voltar para a janela/aba: confirma a conexão e puxa o que mudou em outro dispositivo (com intervalo mínimo).
  useEffect(() => {
    if (!entitled || !ready) return;
    const wake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const p = syncRef.current.phase;
      const min = p === 'offline' || p === 'error' ? WAKE_MIN_INTERVAL_FAILING_MS : WAKE_MIN_INTERVAL_MS;
      if (Date.now() - lastRunAt.current >= min) void run();
    };
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [entitled, ready, run]);
  // Pendência real = diferença entre os dados locais e a última versão confirmada pelo servidor (guardada no IndexedDB).
  const hasPending = useMemo(() => (entitled && ready && metaRef.current ? buildPushes(data, metaRef.current).length > 0 : false), [data, entitled, ready, sync, conflicts]);

  const value: Ctx = {
    status, session, auth, quotes, entitled, access, requireLogin, setSession,
    async signOut(): Promise<SignOutResult> {
      if (auth) {
        if (!csrfRef.current) return { ok: false, message: 'Não foi possível confirmar a saída agora. Recarregue a página e tente de novo.' };
        const r = await auth.logout(csrfRef.current);
        if (!r.ok) return { ok: false, message: `Você continua conectado: não foi possível confirmar a saída no servidor. ${AUTH_MESSAGES[r.reason]}` };
      }
      writeLastAccess(undefined); setNetworkDown(false); setSession(undefined); setSync({ phase: 'idle', blocked: null }); blockedRef.current = null; return { ok: true };
    },
    sync, syncNow: () => run(),
    async chooseMerge() { blockedRef.current = null; setSync(s => ({ ...s, blocked: null })); await run({ allowInitialMerge: true }); },
    /** Troca os dados deste dispositivo pelos da conta (a tela pede confirmação e sugere backup antes). */
    async adoptAccountData() {
      const sess = sessionRef.current; if (!sess) return;
      blockedRef.current = null;
      metaRef.current = { ...emptyMeta(), userId: sess.user.id };
      await saveSyncMeta(metaRef.current).catch(() => undefined);
      setData(() => { const next = emptyDataSet(); appProduced.current.add(next); return next; });
      dataRef.current = emptyDataSet();
      setSync(s => ({ ...s, blocked: null }));
      await run();
    },
    authNotice, conflicts,
    dismissConflicts() {
      if (!metaRef.current) return;
      const kept = metaRef.current.conflicts.filter(isUnresolved); // decisões e dinheiro pendentes nunca somem em silêncio
      metaRef.current = { ...metaRef.current, conflicts: kept }; void saveSyncMeta(metaRef.current).catch(() => undefined); setConflicts(kept);
    },
    openFinancial: conflicts.filter(isOpenFinancial).length,
    pendingConflicts, conflictsOpen, setConflictsOpen,
    resolveConflict(conflictId, action, expectedServerRev) {
      const meta = metaRef.current; if (!meta) throw new Error('Os dados de sincronização ainda não foram carregados.');
      const res = resolveConflictPure(dataRef.current, meta, conflictId, action, new Date(), expectedServerRev); // lança se a regra impedir; nada é alterado antes disso
      metaRef.current = res.meta; dataRef.current = res.data; appProduced.current.add(res.data);
      setData(() => res.data); setConflicts(res.meta.conflicts);
      // Primeiro o estado de sincronização (com a base nova), depois a tentativa de envio.
      void saveSyncMeta(res.meta).catch(() => undefined).then(() => run());
    },
    hasPending,
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
