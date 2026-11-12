import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, CalendarDays, ChefHat, ClipboardCheck, LayoutDashboard, Ruler, Settings, ShoppingBasket } from 'lucide-react';
import type { DataSet } from './domain/types';
import { emptyData, loadData, saveData } from './storage/db';
import { createSaveQueue } from './storage/saveQueue';
import type { Page, PageProps } from './utils';
import { AccountProvider, useAccount } from './account/AccountContext';
import { ConflictDialog } from './features/account/ConflictDialog';
import { conflictTitle } from './sync/describe';
import { SyncDot } from './components/SyncDot';
import { deriveIndicator, useBrowserOnline, useStableIndicator } from './account/syncIndicator';
import { AccessGate } from './components/AccessGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardPage } from './pages/DashboardPage';
import { IngredientsPage } from './pages/IngredientsPage';
import { RecipesPage } from './pages/RecipesPage';
import { OrdersPage } from './pages/OrdersPage';
import { AgendaPage } from './pages/AgendaPage';
import { ConverterPage } from './pages/ConverterPage';
import { SettingsPage } from './pages/SettingsPage';
import { BackupPage } from './pages/BackupPage';

const pages: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Visão geral', icon: LayoutDashboard }, { id: 'ingredients', label: 'Ingredientes', icon: ShoppingBasket },
  { id: 'recipes', label: 'Receitas e preços', icon: ChefHat }, { id: 'orders', label: 'Encomendas', icon: ClipboardCheck }, { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'converter', label: 'Conversor', icon: Ruler }, { id: 'backup', label: 'Backup', icon: ArchiveRestore }, { id: 'settings', label: 'Configurações', icon: Settings },
];

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

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [data, setData] = useState<DataSet>(emptyData);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState('');
  const queue = useRef(createSaveQueue<DataSet>(saveData));

  useEffect(() => { let alive = true; loadData().then(d => { if (alive) { setData(d); setReady(true); } }).catch(() => { if (alive) { setFeedback('Armazenamento indisponível. Suas alterações não serão persistidas.'); setReady(true); } }); return () => { alive = false; }; }, []);
  useEffect(() => { if (!ready) return; queue.current.enqueue(data).catch(() => setFeedback('Não foi possível salvar neste navegador. Exporte um backup dos dados.')); }, [data, ready]);
  /** Restaura um backup: atualiza a tela e grava pela MESMA fila, para não competir com gravações em andamento. */
  const replaceData = (next: DataSet) => { setData(next); return queue.current.enqueue(next); };

  // Leitores de tela: ao trocar de página, o foco vai para o título dela.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const h1 = document.querySelector<HTMLElement>('.content h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
  }, [page]);

  const inform = (msg: string) => { setFeedback(msg); window.setTimeout(() => setFeedback(''), 4500); };
  const focus = (p: Page) => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const props: PageProps = { data, update: setData, inform, focus };

  return <AccountProvider data={data} setData={setData} ready={ready}><AccessGate data={data}><div className="app"><a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><ClipboardCheck size={22} /></div><span>Pedido<span style={{ color: '#ff982b' }}>Certo</span></span></div><nav className="nav" aria-label="Navegação principal">{pages.map(p => { const Icon = p.icon; return <button key={p.id} className={page === p.id ? 'active' : ''} aria-current={page === p.id ? 'page' : undefined} onClick={() => focus(p.id)}><Icon size={18} />{p.label}</button>; })}</nav><div className="sidebar-foot"><strong style={{ color: 'white' }}>Versão beta</strong><br />Seus dados ficam neste navegador e, se você entrar numa conta (opcional), também no servidor. Exporte backups regularmente.</div></aside>
    <main className="workspace"><header className="topbar"><strong>Seu espaço de trabalho</strong><TopbarStatus /><div className="avatar"><ChefHat size={16} /></div></header><div className="content" id="conteudo">
      <SyncBanner focus={focus} />
      <ConflictBanner />
      <ErrorBoundary key={page}>{!ready ? <div className="empty" role="status" aria-live="polite">Carregando seus dados…</div> : <>
      {page === 'dashboard' && <DashboardPage {...props} />}
      {page === 'ingredients' && <IngredientsPage {...props} />}
      {page === 'recipes' && <RecipesPage {...props} />}
      {page === 'orders' && <OrdersPage {...props} />}
      {page === 'agenda' && <AgendaPage {...props} />}
      {page === 'converter' && <ConverterPage {...props} />}
      {page === 'settings' && <SettingsPage {...props} />}
      {page === 'backup' && <BackupPage {...props} replaceData={replaceData} />}
      </>}</ErrorBoundary>
    </div></main><ConflictDialog inform={inform} />{feedback && <div className="toast" role="status" aria-live="polite">{feedback}</div>}
  </div></AccessGate></AccountProvider>;
}
