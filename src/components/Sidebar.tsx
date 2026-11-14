import { ArchiveRestore, CalendarDays, ChefHat, ChevronRight, ClipboardList, LayoutDashboard, Package, PlusCircle, Ruler, Settings, ShoppingBasket } from 'lucide-react';
import { useState } from 'react';
import type { Page } from '../utils';

const pages: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'ingredients', label: 'Ingredientes', icon: ShoppingBasket },
  { id: 'packagings', label: 'Embalagens', icon: Package },
  { id: 'recipes', label: 'Receitas e preços', icon: ChefHat },
  { id: 'new-order', label: 'Nova encomenda', icon: PlusCircle },
  { id: 'orders', label: 'Pedidos', icon: ClipboardList },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'converter', label: 'Conversor', icon: Ruler },
  { id: 'backup', label: 'Backup', icon: ArchiveRestore },
  { id: 'settings', label: 'Configurações', icon: Settings },
];

export function Sidebar({ activePage, onNavigate }: { activePage: Page; onNavigate: (page: Page) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Menu lateral">
    <div className="sidebar-brand-row">
      <div className="brand" aria-label="Custô">
        <span className="brand-logo-wrap">
          <img className="brand-logo brand-logo-full" src="/brand/custo-color.svg" alt="Custô" />
          <img className="brand-logo brand-logo-icon" src="/brand/favicon-custo-color.svg" alt="" aria-hidden="true" />
        </span>
      </div>
      <button className="sidebar-toggle" type="button" aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'} aria-expanded={!collapsed} aria-controls="primary-navigation" title={collapsed ? 'Expandir menu' : 'Recolher menu'} onClick={() => setCollapsed(value => !value)}>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
    <nav className="nav" id="primary-navigation" aria-label="Navegação principal">
      {pages.map(({ id, label, icon: Icon }) => <button key={id} className={activePage === id ? 'active' : ''} aria-label={label} title={label} aria-current={activePage === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
        <Icon size={18} aria-hidden="true" /><span className="nav-label">{label}</span>
      </button>)}
    </nav>
    <div className="sidebar-foot"><strong>Versão beta</strong><br />Seus dados ficam neste navegador e na sua conta quando você entra. Exporte backups regularmente.</div>
  </aside>;
}
