import { useMemo, useState } from 'react';
import { ArrowRight, ClipboardCheck, Plus } from 'lucide-react';
import { OrderSearch } from '../components/OrderSearch';
import { QuoteCode } from '../components/QuoteCode';
import { filterOrders } from '../domain/orderSearch';
import { balanceDue, orderTotal, totalReceived } from '../domain/payments';
import { money } from '../domain/pricing';
import type { Order } from '../domain/types';
import { effectiveQuoteCodes } from '../../shared/quoteCode';
import { brDate, type PageProps } from '../utils';
import { FinancialPendingNotice } from '../features/orders/FinancialPendingNotice';

type StatusFilter = 'Todos' | Order['status'];
const filters: { value: StatusFilter; label: string }[] = [
  { value: 'Todos', label: 'Todos' }, { value: 'Orçamento', label: 'Orçamento' },
  { value: 'Confirmado', label: 'Confirmado' }, { value: 'Produção', label: 'Em produção' }, { value: 'Entregue', label: 'Entregue' },
];
const statusLabel = (status: Order['status']) => status === 'Produção' ? 'Em produção' : status;

export function OrdersPage({ data, focus, openOrder }: PageProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('Todos');
  const codes = useMemo(() => effectiveQuoteCodes(data.orders), [data.orders]);
  const searched = useMemo(() => filterOrders(data.orders, query, { codes, productOf: o => data.recipes.find(r => r.id === o.recipeId)?.name ?? '' }), [data.orders, data.recipes, codes, query]);
  const visible = useMemo(() => searched.filter(o => status === 'Todos' || o.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [searched, status]);

  return <>
    <div className="head"><div><div className="eyebrow">Atendimento e organização</div><h1>Pedidos</h1><p className="muted">Acompanhe suas encomendas, pagamentos e entregas.</p></div><button className="primary" onClick={() => focus('new-order')}><Plus size={17} /> Nova encomenda</button></div>
    <FinancialPendingNotice focus={focus} />
    <section className="card orders-list-card" aria-label="Lista de pedidos">
      <div className="orders-list-toolbar"><OrderSearch value={query} onChange={setQuery} /><span className="muted" aria-live="polite">{visible.length} de {data.orders.length} pedidos</span></div>
      <div className="order-status-filters" role="group" aria-label="Filtrar pedidos por status">
        {filters.map(item => <button key={item.value} type="button" className={status === item.value ? 'order-status-filter active' : 'order-status-filter'} aria-pressed={status === item.value} onClick={() => setStatus(item.value)}>{item.label}</button>)}
      </div>
      {data.orders.length === 0 ? <div className="empty orders-empty"><ClipboardCheck size={30} /><strong>Nenhum pedido cadastrado.</strong><span>Registre a primeira encomenda para acompanhar prazos e pagamentos.</span><button className="primary" onClick={() => focus('new-order')}><Plus size={16} /> Nova encomenda</button></div>
        : visible.length === 0 ? <div className="empty orders-empty" role="status"><ClipboardCheck size={30} /><strong>{query.trim() ? 'Nenhum pedido encontrado.' : `Nenhum pedido com status “${statusLabel(status as Order['status'])}”.`}</strong><span>{query.trim() ? 'Revise a busca ou limpe o filtro de status.' : 'Escolha outro status para consultar os pedidos.'}</span>{query.trim() && <button className="secondary" onClick={() => setQuery('')}>Limpar pesquisa</button>}</div>
          : <div className="orders-table-wrap"><div className="orders-table-head" aria-hidden="true"><span>Pedido</span><span>Status</span><span>Total</span><span>Recebido</span><span>Saldo</span><span>Entrega</span><span /></div>
            <ul className="orders-list">{visible.map(order => {
              const recipe = data.recipes.find(r => r.id === order.recipeId);
              return <li className="order-list-row" key={order.id}>
                <div className="order-list-primary"><div><QuoteCode code={codes.get(order.id)!} /><strong>{order.customer}</strong></div><span className="muted">{recipe?.name ?? 'Receita indisponível'} · {order.quantity} un.</span></div>
                <div className="order-list-status"><span className="order-mobile-label">Status</span><span className="tag">{statusLabel(order.status)}</span></div>
                <div><span className="order-mobile-label">Total</span><strong>{money(orderTotal(order))}</strong></div>
                <div><span className="order-mobile-label">Recebido</span><strong>{money(totalReceived(order))}</strong></div>
                <div><span className="order-mobile-label">Saldo</span><strong className={balanceDue(order) > 0 ? 'order-balance-pending' : 'order-balance-paid'}>{money(balanceDue(order))}</strong></div>
                <div><span className="order-mobile-label">Entrega</span><span>{brDate(order.deliveryDate)}</span></div>
                <button className="secondary order-detail-link" onClick={() => openOrder(order.id)}>Ver detalhes <ArrowRight size={15} /></button>
              </li>;
            })}</ul>
          </div>}
    </section>
    <p className="footnote">A situação operacional e os pagamentos são independentes. Um pedido entregue pode continuar com saldo pendente.</p>
  </>;
}
