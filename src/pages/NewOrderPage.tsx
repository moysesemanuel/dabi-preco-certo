import { CalendarDays } from 'lucide-react';
import type { PageProps } from '../utils';
import { OrderForm } from '../features/orders/OrderForm';
import { FinancialPendingNotice } from '../features/orders/FinancialPendingNotice';

export function NewOrderPage(props: PageProps) {
  return <>
    <div className="head"><div><div className="eyebrow">Atendimento</div><h1>Nova encomenda</h1><p className="muted">Registre os dados, confira o total e acompanhe o saldo.</p></div><button type="button" className="secondary" onClick={() => props.focus('orders')}><CalendarDays size={16} /> Ver pedidos</button></div>
    <FinancialPendingNotice focus={props.focus} />
    <section className="card order-form-card"><OrderForm {...props} onSaved={order => props.openOrder(order.id)} /></section>
  </>;
}
