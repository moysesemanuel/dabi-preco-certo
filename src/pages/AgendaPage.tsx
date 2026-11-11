import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { balanceDue } from '../domain/payments';
import { money } from '../domain/pricing';
import { buildAgenda, FORECAST_DISCLAIMER, formatMinutes, workloadForecast, type Viability } from '../domain/schedule';
import type { Order } from '../domain/types';
import { brDate, localToday, type PageProps } from '../utils';

const VIABILITY: Record<Exclude<Viability, 'unknown'>, { label: string; className: string }> = {
  ok: { label: 'Com folga', className: 'tag green' }, tight: { label: 'Apertado', className: 'tag orange' }, overload: { label: 'Sobrecarga', className: 'tag red' },
};
const STATUSES: Order['status'][] = ['Orçamento', 'Confirmado', 'Produção', 'Entregue'];

export function AgendaPage({ data, update, focus }: PageProps) {
  const today = localToday();
  const [includeQuotes, setIncludeQuotes] = useState(false);
  const agenda = useMemo(() => buildAgenda(data.orders, today, includeQuotes), [data.orders, today, includeQuotes]);
  const forecast = useMemo(() => workloadForecast(data, today, 14), [data, today]);
  const recipeName = (id: string) => data.recipes.find(r => r.id === id)?.name ?? 'Receita indisponível';
  const setStatus = (id: string, status: Order['status']) => update(d => ({ ...d, orders: d.orders.map(o => (o.id === id ? { ...o, status } : o)) }));
  const hasCapacity = !!data.settings?.dailyCapacityMinutes;

  const Row = ({ order, late }: { order: Order; late?: number }) => (
    <li style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f0f2f4' }}>
      <div><strong>{order.customer}</strong><div className="muted" style={{ fontSize: 13 }}>{recipeName(order.recipeId)} · {order.quantity} un. · entrega {brDate(order.deliveryDate)}</div>
        <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {late !== undefined && <span className="tag red">{late} dia(s) de atraso</span>}
          {balanceDue(order) > 0 && <span className="tag orange">A receber {money(balanceDue(order))}</span>}
        </div></div>
      <select aria-label={`Status do pedido de ${order.customer}`} value={order.status} onChange={e => setStatus(order.id, e.target.value as Order['status'])} style={{ width: 150, height: 38 }}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select>
    </li>
  );
  const List = ({ items }: { items: { order: Order; late?: number }[] }) => <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{items.map(i => <Row key={i.order.id} order={i.order} late={i.late} />)}</ul>;

  return <>
    <div className="head"><div><div className="eyebrow">Organização das entregas</div><h1>Agenda</h1><p className="muted">Entregas de hoje, dos próximos dias e atrasos, e uma estimativa da carga de produção.</p></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: 0 }}><input type="checkbox" checked={includeQuotes} onChange={e => setIncludeQuotes(e.target.checked)} style={{ width: 18, height: 18 }} /> Incluir orçamentos</label></div>

    {agenda.overdue.length > 0 && <section className="card" style={{ marginBottom: 19, borderColor: '#e8b4b4' }}><h2 className="section-title" style={{ color: '#c43d3d' }}>Atrasados ({agenda.overdue.length})</h2><List items={agenda.overdue.map(o => ({ order: o.order, late: o.daysLate }))} /></section>}

    <div className="two">
      <section className="card"><h2 className="section-title">Hoje · {brDate(today)}</h2>
        {agenda.today.length ? <List items={agenda.today.map(order => ({ order }))} /> : <div className="empty"><CalendarDays size={30} />Nenhuma entrega para hoje.</div>}
        <h2 className="section-title" style={{ marginTop: 24 }}>Próximos dias</h2>
        {agenda.week.map(day => <div key={day.date} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#445268' }}>{day.weekday}, {brDate(day.date)}</div>
          {day.orders.length ? <List items={day.orders.map(order => ({ order }))} /> : <div className="muted" style={{ fontSize: 13 }}>Sem entregas.</div>}
        </div>)}
        {agenda.later.length > 0 && <><h2 className="section-title" style={{ marginTop: 18 }}>Mais adiante ({agenda.later.length})</h2><List items={agenda.later.map(order => ({ order }))} /></>}
      </section>

      <section className="card"><h2 className="section-title">Carga de produção</h2>
        <p className="muted">Próximos 14 dias, com a carga acumulada até cada entrega.</p>
        {!hasCapacity && <div className="notice warn" style={{ margin: '12px 0' }}>Informe a capacidade diária em <button type="button" className="secondary" style={{ minHeight: 32, padding: '4px 10px' }} onClick={() => focus('settings')}>Configurações</button> para ver a estimativa.</div>}
        {forecast.length ? <div className="table-wrap"><table><thead><tr><th>Data</th><th>Pedidos</th><th>Carga / disponível</th><th>Situação</th></tr></thead><tbody>{forecast.map(f => <tr key={f.date}><td>{brDate(f.date)}</td><td>{f.orders}</td><td>{hasCapacity ? `${formatMinutes(f.requiredMinutes)} / ${formatMinutes(f.availableMinutes)}` : '—'}</td><td>{f.status === 'unknown' ? <span className="muted">—</span> : <span className={VIABILITY[f.status].className}>{VIABILITY[f.status].label}</span>}</td></tr>)}</tbody></table></div> : <div className="empty">Sem entregas nos próximos 14 dias.</div>}
        {forecast.some(f => f.ignored.length) && <p className="footnote">Alguns pedidos estão sem tempo de produção na receita e não entram na conta.</p>}
        <p className="footnote">{FORECAST_DISCLAIMER}</p>
      </section>
    </div>
  </>;
}
