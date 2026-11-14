import { useEffect, useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import type { DataSet } from './domain/types';
import { emptyData, loadDataVersioned, readDataVersion, saveDataCas, StaleWriteError } from './storage/db';
import { createCoordinator, type Role } from './storage/coordination';
import { createSaveQueue } from './storage/saveQueue';
import { downloadBackup, type Page, type PageProps } from './utils';
import { AccountProvider, useAccount } from './account/AccountContext';
import { ConflictDialog } from './features/account/ConflictDialog';
import { conflictTitle } from './sync/describe';
import { SyncDot } from './components/SyncDot';
import { deriveIndicator, useBrowserOnline, useStableIndicator } from './account/syncIndicator';
import { AccessGate } from './components/AccessGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardPage } from './pages/DashboardPage';
import { IngredientsPage } from './pages/IngredientsPage';
import { PackagingsPage } from './pages/PackagingsPage';
import { RecipesPage } from './pages/RecipesPage';
import { OrdersPage } from './pages/OrdersPage';
import { NewOrderPage } from './pages/NewOrderPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { AgendaPage } from './pages/AgendaPage';
import { ConverterPage } from './pages/ConverterPage';
import { SettingsPage } from './pages/SettingsPage';
import { BackupPage } from './pages/BackupPage';
import { Sidebar } from './components/Sidebar';
import { pathForRoute, routeFromPath } from './appRoutes';

/** Aviso quando a sincronização precisa de uma decisão sua (por exemplo, dados dos dois lados na primeira entrada). */
function SyncBanner({ focus }: { focus: (p: Page) => void }) {
  const acc = useAccount();
  if (!acc.sync.blocked) return null;
  return <div className="notice warn" role="alert"><strong>A sincronização precisa da sua decisão.</strong> Nada foi alterado ainda. <button className="secondary" onClick={() => focus('settings')}>Resolver em Configurações</button></div>;
}

/** Banner persistente de conflitos: derivado do estado salvo (não é um toast e não some sozinho). */
function ConflictBanner() {
  const acc = useAccount();
  if (acc.status !== 'signed-in' || acc.sync.blocked) return null;
  const list = acc.pendingConflicts;
  const total = list.length + acc.openFinancial;
  if (total === 0) return null;
  const first = list[0];
  const text = total === 1 && first
    ? `${conflictTitle(first)} foi modificado em outro dispositivo. Sua alteração foi preservada e nada foi sobrescrito.`
    : `${total} registros foram modificados aqui e em outro dispositivo. As suas alterações foram preservadas e nada foi sobrescrito.`;
  return <div className="notice warn conflict-banner" role="region" aria-label="Conflitos de sincronização"><div><strong>{total > 1 ? `Encontramos ${total} alterações diferentes` : 'Encontramos alterações diferentes'}</strong><br />{text}</div>
    <button className="secondary" onClick={() => acc.setConflictsOpen(true)}>Acessar conflitos{total > 1 ? ` (${total})` : ''}</button></div>;
}

/** Estado dos dados no topo: local, ou o e-mail da conta com um indicador circular da saúde da sincronização. */
function TopbarStatus() {
  const acc = useAccount();
  const online = useBrowserOnline();
  const raw = deriveIndicator({ sync: acc.sync, hasPending: acc.hasPending, conflicts: acc.pendingConflicts.length + acc.openFinancial, entitled: acc.entitled, browserOnline: online });
  const level = useStableIndicator(raw);
  if (acc.status !== 'signed-in') return <span role="status">Dados salvos neste dispositivo</span>;
  const email = acc.session?.user.email;
  if (!acc.entitled) return <span role="status">{email} · sem licença ativa</span>;
  return <span className="sync-status">{email}<SyncDot level={level} label={raw.label} detail={raw.detail} /><span className="sr-only" role="status" aria-live="polite">{level === 'ok' ? 'Sincronização em dia' : level === 'bad' || level === 'conflict' ? raw.label : 'Sincronização sem confirmação'}</span></span>;
}

/** Uma por aba (criada ao carregar o módulo): decide qual aba edita e avisa as outras. */
const coordinator = createCoordinator();

const VIEW_MSG = 'Esta aba está em modo de consulta. Assuma a edição para alterar.';
/** Aba em modo de consulta: mostra os dados, mas não grava nem sincroniza (evita que duas abas sobrescrevam uma à outra). */
function ViewerBanner({ canTakeOver, onTakeOver }: { canTakeOver: boolean; onTakeOver: () => void }) {
  return <div className="notice warn viewer-banner" role="region" aria-label="Modo de consulta"><div><strong>Este aplicativo está aberto em outra aba.</strong><br />Aqui você pode consultar seus dados, mas não alterá-los, para que nada seja perdido. Para editar nesta aba, assuma a edição: a outra aba passa a só consultar.</div>
    {canTakeOver && <button className="secondary" onClick={onTakeOver}>Editar nesta aba</button>}</div>;
}
/** A gravação desta aba foi recusada porque outra aba alterou os dados antes: nada foi apagado, e as alterações desta aba continuam aqui. */
function LostWorkBanner({ onDownload, onReload }: { onDownload: () => void; onReload: () => void }) {
  return <div className="notice warn viewer-banner" role="alert"><div><strong>Os dados foram alterados em outra aba.</strong><br />Para não apagar o que foi feito lá, as últimas alterações desta aba <strong>não foram salvas</strong>. Baixe uma cópia delas (se precisar) e carregue os dados atuais.</div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="secondary" onClick={onDownload}>Baixar cópia das minhas alterações</button><button className="primary" onClick={onReload}>Carregar os dados atuais</button></div></div>;
}

export default function App() {
  const [route, setRoute] = useState(() => routeFromPath(window.location.pathname));
  const page = route.page;
  const [data, setData] = useState<DataSet>(emptyData);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [role, setRole] = useState<Role>('pending');
  const [blocked, setBlocked] = useState<DataSet | null>(null); // cópia das alterações que NÃO puderam ser salvas (outra aba gravou antes)
  const [epoch, setEpoch] = useState(0);        // muda ao ASSUMIR a edição: a conta é verificada de novo antes de sincronizar
  const [metaVersion, setMetaVersion] = useState(0); // muda quando outra aba grava: o estado de sincronização é relido do disco
  const versionRef = useRef(0);                 // versão do documento que ESTA aba leu/gravou por último
  const persisted = useRef<DataSet | null>(null);
  const wasViewer = useRef(false);
  const eff: Role = blocked ? 'viewer' : role;  // papel efetivo
  const effRef = useRef(eff); effRef.current = eff;
  const queue = useRef(createSaveQueue<DataSet>(async d => { const v = await saveDataCas(d, versionRef.current); versionRef.current = v; coordinator.notifySaved(v); }));

  /**
   * Relê os dados do disco. `refresh`: aba em consulta acompanhando o editor (só se mudou). `promote`: esta aba acabou de assumir a edição
   * (o bloqueio de edição e de sincronização já foi armado em `onRole`; aqui só se termina de carregar). `reset`: descartar o que não foi salvo e carregar o atual.
   */
  const reload = useRef((_mode: 'refresh' | 'promote' | 'reset') => Promise.resolve());
  reload.current = async mode => {
    if (mode === 'reset') { setReady(false); setEpoch(n => n + 1); }
    const { data: d, version } = await loadDataVersioned();
    if (mode === 'refresh' && version === versionRef.current) return;
    versionRef.current = version; persisted.current = d; setData(d); setBlocked(null); setMetaVersion(n => n + 1); setReady(true);
  };
  const prevRole = useRef<Role>('pending');
  // Ao PASSAR a editar (depois de ter só consultado), a aba é "travada" no mesmo instante: sem editar nem sincronizar até reler o disco e verificar a conta.
  const onRole = (r: Role) => { if (r === 'editor' && prevRole.current === 'viewer') { setReady(false); setEpoch(n => n + 1); } prevRole.current = r; setRole(r); };

  useEffect(() => { coordinator.start({ onRole, onRemoteSaved: () => { if (effRef.current !== 'editor') void reload.current('refresh'); } }); return () => coordinator.stop(); }, []);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => { let alive = true; loadDataVersioned().then(({ data: d, version }) => { if (alive) { versionRef.current = version; persisted.current = d; setData(d); setReady(true); } }).catch(() => { if (alive) { setFeedback('Armazenamento indisponível. Suas alterações não serão persistidas.'); setReady(true); } }); return () => { alive = false; }; }, []);
  // Ao assumir a edição depois de ter sido só consulta, os dados são relidos do disco ANTES de permitir alterações.
  useEffect(() => { if (role === 'viewer') wasViewer.current = true; if (role === 'editor' && wasViewer.current) { wasViewer.current = false; void reload.current('promote'); } }, [role]);
  // Em consulta: relê ao voltar o foco (sem rede; cobre navegadores sem BroadcastChannel e abas que estavam suspensas).
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'hidden' || effRef.current === 'editor') return; void readDataVersion().then(v => { if (v !== versionRef.current) void reload.current('refresh'); }).catch(() => undefined); };
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check); return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, []);
  const onSaveError = (e: unknown, snapshot: DataSet) => { if (e instanceof StaleWriteError) setBlocked(snapshot); else setFeedback('Não foi possível salvar neste navegador. Exporte um backup dos dados.'); };
  useEffect(() => {
    if (!ready || eff !== 'editor' || data === persisted.current) return; // só o editor grava; dados recém-lidos do disco não são regravados
    persisted.current = data; queue.current.enqueue(data).catch(e => onSaveError(e, data));
  }, [data, ready, eff]); // eslint-disable-line react-hooks/exhaustive-deps
  // Em consulta, alterações são ignoradas e QUALQUER mensagem das páginas é trocada pelo aviso de consulta (para nunca parecer que algo foi salvo).
  const guarded = (fn: (d: DataSet) => DataSet) => { if (effRef.current === 'editor') setData(fn); };
  const informPage = (msg: string) => inform(effRef.current === 'editor' ? msg : VIEW_MSG);
  /** Restaura um backup: atualiza a tela e grava pela MESMA fila, para não competir com gravações em andamento. */
  const replaceData = (next: DataSet) => { if (effRef.current !== 'editor') { inform(VIEW_MSG); return Promise.resolve(); } setData(next); return queue.current.enqueue(next); };

  // Leitores de tela: ao trocar de página, o foco vai para o título dela.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const h1 = document.querySelector<HTMLElement>('.content h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
  }, [page]);

  const inform = (msg: string) => { setFeedback(msg); window.setTimeout(() => setFeedback(''), 4500); };
  const navigate = (next: ReturnType<typeof routeFromPath>) => { window.history.pushState({}, '', pathForRoute(next)); setRoute(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const focus = (p: Page) => navigate({ page: p });
  const openOrder = (id: string) => navigate({ page: 'order-detail', orderId: id });
  const props: PageProps = { data, update: guarded, inform: informPage, focus, openOrder };
  const viewer = eff === 'viewer';

  return <AccountProvider data={data} setData={setData} ready={ready && eff === 'editor'} epoch={epoch} metaVersion={metaVersion}><AccessGate data={data}><div className="app"><a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <Sidebar activePage={page === 'order-detail' ? 'orders' : page} onNavigate={focus} />
    <main className="workspace"><header className="topbar"><strong>Seu espaço de trabalho</strong><TopbarStatus /><div className="avatar"><UserRound size={16} aria-hidden="true" /></div></header><div className="content" id="conteudo">
      {blocked ? <LostWorkBanner onDownload={() => downloadBackup(blocked)} onReload={() => { void reload.current('reset'); }} /> : viewer && <ViewerBanner canTakeOver={coordinator.supported} onTakeOver={() => coordinator.takeOver()} />}
      {!viewer && <SyncBanner focus={focus} />}
      {!viewer && <ConflictBanner />}
      <ErrorBoundary key={page}>{!ready ? <div className="empty" role="status" aria-live="polite">Carregando seus dados…</div> : <>
      {page === 'dashboard' && <DashboardPage {...props} />}
      {page === 'ingredients' && <IngredientsPage {...props} />}
      {page === 'packagings' && <PackagingsPage {...props} />}
      {page === 'recipes' && <RecipesPage {...props} />}
      {page === 'new-order' && <NewOrderPage {...props} />}
      {page === 'orders' && <OrdersPage {...props} />}
      {page === 'order-detail' && <OrderDetailPage {...props} orderId={route.orderId ?? ''} />}
      {page === 'agenda' && <AgendaPage {...props} />}
      {page === 'converter' && <ConverterPage {...props} />}
      {(page === 'settings' || page === 'backup') && viewer ? <div className="empty" role="status">Esta página só pode ser usada na aba que está editando. Assuma a edição nesta aba para continuar.</div> : <>
      {page === 'settings' && <SettingsPage {...props} />}
      {page === 'backup' && <BackupPage {...props} replaceData={replaceData} />}</>}
      </>}</ErrorBoundary>
    </div></main>{!viewer && <ConflictDialog inform={inform} packagings={data.packagings ?? []} />}{feedback && <div className="toast" role="status" aria-live="polite">{feedback}</div>}
  </div></AccessGate></AccountProvider>;
}
