import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, CalendarDays, ChefHat, ClipboardCheck, LayoutDashboard, Ruler, Settings, ShoppingBasket } from 'lucide-react';
import type { DataSet } from './domain/types';
import { emptyData, loadData, saveData } from './storage/db';
import { createSaveQueue } from './storage/saveQueue';
import type { Page, PageProps } from './utils';
import { AccountProvider, useAccount } from './account/AccountContext';
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

/** Estado dos dados no topo da tela: local, ou sincronizado quando há conta. */
function TopbarStatus() {
  const acc = useAccount();
  const text = acc.status !== 'signed-in' ? 'Dados salvos neste dispositivo'
    : !acc.entitled ? `${acc.session?.user.email} · sem licença ativa`
    : acc.sync.blocked ? `${acc.session?.user.email} · precisa da sua decisão`
    : acc.openFinancial > 0 ? `${acc.session?.user.email} · recebimentos a reconciliar`
    : ({ idle: 'aguardando', syncing: 'sincronizando…', synced: 'sincronizado', offline: 'sem conexão (será enviado depois)', attention: 'precisa de atenção', error: 'falha ao sincronizar' } as const)[acc.sync.phase];
  return <span role="status" aria-live="polite">{acc.status === 'signed-in' && acc.entitled && !acc.sync.blocked && acc.openFinancial === 0 ? `${acc.session?.user.email} · ${text}` : text}</span>;
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

  return <AccountProvider data={data} setData={setData} ready={ready}><div className="app"><a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><ClipboardCheck size={22} /></div><span>Pedido<span style={{ color: '#ff982b' }}>Certo</span></span></div><nav className="nav" aria-label="Navegação principal">{pages.map(p => { const Icon = p.icon; return <button key={p.id} className={page === p.id ? 'active' : ''} aria-current={page === p.id ? 'page' : undefined} onClick={() => focus(p.id)}><Icon size={18} />{p.label}</button>; })}</nav><div className="sidebar-foot"><strong style={{ color: 'white' }}>Versão beta</strong><br />Seus dados ficam neste navegador e, se você entrar numa conta (opcional), também no servidor. Exporte backups regularmente.</div></aside>
    <main className="workspace"><header className="topbar"><strong>Seu espaço de trabalho</strong><TopbarStatus /><div className="avatar"><ChefHat size={16} /></div></header><div className="content" id="conteudo">
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
    </div></main>{feedback && <div className="toast" role="status" aria-live="polite">{feedback}</div>}
  </div></AccountProvider>;
}
