import { useEffect, useState } from 'react';
import { ArchiveRestore, ChefHat, ClipboardCheck, LayoutDashboard, ShoppingBasket } from 'lucide-react';
import type { DataSet } from './domain/types';
import { emptyData, loadData, saveData } from './storage/db';
import type { Page, PageProps } from './utils';
import { DashboardPage } from './pages/DashboardPage';
import { IngredientsPage } from './pages/IngredientsPage';
import { RecipesPage } from './pages/RecipesPage';
import { OrdersPage } from './pages/OrdersPage';
import { BackupPage } from './pages/BackupPage';

const pages: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Visão geral', icon: LayoutDashboard }, { id: 'ingredients', label: 'Ingredientes', icon: ShoppingBasket },
  { id: 'recipes', label: 'Receitas e preços', icon: ChefHat }, { id: 'orders', label: 'Encomendas', icon: ClipboardCheck },
  { id: 'backup', label: 'Backup', icon: ArchiveRestore },
];

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [data, setData] = useState<DataSet>(emptyData);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => { let alive = true; loadData().then(d => { if (alive) { setData(d); setReady(true); } }).catch(() => { if (alive) { setFeedback('Armazenamento indisponível. Suas alterações não serão persistidas.'); setReady(true); } }); return () => { alive = false; }; }, []);
  useEffect(() => { if (!ready) return; saveData(data).catch(() => setFeedback('Não foi possível salvar neste navegador. Exporte um backup dos dados.')); }, [data, ready]);

  const inform = (msg: string) => { setFeedback(msg); window.setTimeout(() => setFeedback(''), 4500); };
  const focus = (p: Page) => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const props: PageProps = { data, update: setData, inform, focus };

  return <div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><ClipboardCheck size={22} /></div><span>Pedido<span style={{ color: '#ff982b' }}>Certo</span></span></div><nav className="nav" aria-label="Navegação principal">{pages.map(p => { const Icon = p.icon; return <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => focus(p.id)}><Icon size={18} />{p.label}</button>; })}</nav><div className="sidebar-foot"><strong style={{ color: 'white' }}>Versão inicial · 0.1</strong><br />Seus dados ficam neste navegador. Exporte backups regularmente.</div></aside>
    <main className="workspace"><header className="topbar"><strong>Seu espaço de trabalho</strong><span>Primeira versão · dados locais</span><div className="avatar"><ChefHat size={16} /></div></header><div className="content">
      {page === 'dashboard' && <DashboardPage {...props} />}
      {page === 'ingredients' && <IngredientsPage {...props} />}
      {page === 'recipes' && <RecipesPage {...props} />}
      {page === 'orders' && <OrdersPage {...props} />}
      {page === 'backup' && <BackupPage {...props} replaceData={setData} />}
    </div></main>{feedback && <div className="toast" role="status">{feedback}</div>}
  </div>;
}
