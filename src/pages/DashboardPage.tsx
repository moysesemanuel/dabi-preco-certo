import { ArrowRight, CalendarDays, ChartNoAxesCombined, CheckCircle2, ClipboardCheck, Plus, Wallet } from 'lucide-react';
import { money } from '../domain/pricing';
import { orderUnitCost } from '../domain/orderCost';
import { brDate, type Page, type PageProps } from '../utils';

export function DashboardPage({ data, focus }: PageProps) {
  const confirmed = data.orders.filter(o => o.status !== 'Orçamento');
  const totalRevenue = confirmed.reduce((s, o) => s + o.quantity * o.unitPrice, 0);
  const amountToReceive = confirmed.reduce((s, o) => s + Math.max(0, o.quantity * o.unitPrice - o.deposit), 0);
  const openOrders = data.orders.filter(o => o.status !== 'Entregue');
  // Custo REGISTRADO (histórico) quando existe; senão, estimativa pelo custo atual, sinalizada ao usuário.
  let estimatedCost = 0, withoutRecord = 0, costUnavailable = false;
  for (const o of confirmed) {
    const c = orderUnitCost(o, data);
    if (c.basis === 'unavailable') { costUnavailable = true; continue; }
    if (c.basis === 'estimated') withoutRecord++;
    estimatedCost += c.costPerUnit * o.quantity;
  }
  const steps: { label: string; ok: boolean; pg: Page }[] = [
    { label: 'Cadastre seus ingredientes', ok: data.ingredients.length > 0, pg: 'ingredients' },
    { label: 'Monte sua primeira receita', ok: data.recipes.length > 0, pg: 'recipes' },
    { label: 'Registre uma encomenda', ok: data.orders.length > 0, pg: 'orders' },
    { label: 'Faça um backup dos dados', ok: false, pg: 'backup' },
  ];
  return <>
    <div className="head"><div><div className="eyebrow">Painel principal</div><h1>Bom trabalho começa organizado.</h1><p className="muted">Acompanhe suas encomendas, custos e valores a receber.</p></div><button className="primary" onClick={() => focus('orders')}><Plus size={17} /> Nova encomenda</button></div>
    <div className="welcome"><div><h2>Seu negócio, no caminho certo.</h2><p>Cadastre seus ingredientes, monte receitas e calcule preços antes de aceitar pedidos. Comece por uma tarefa de cada vez.</p></div><button className="primary" onClick={() => focus(data.ingredients.length ? 'recipes' : 'ingredients')}>{data.ingredients.length ? 'Criar receita' : 'Cadastrar ingrediente'} <ArrowRight size={17} /></button></div>
    <div className="cards">
      <div className="card metric-card"><span className="icon-box"><ClipboardCheck size={20} /></span><span className="metric-label">Pedidos em aberto</span><span className="metric">{openOrders.length.toString().padStart(2, '0')}</span></div>
      <div className="card metric-card"><span className="icon-box"><Wallet size={20} /></span><span className="metric-label">A receber*</span><span className="metric">{money(amountToReceive)}</span></div>
      <div className="card metric-card"><span className="icon-box"><CalendarDays size={20} /></span><span className="metric-label">Pedidos confirmados</span><span className="metric">{confirmed.length.toString().padStart(2, '0')}</span></div>
      <div className="card metric-card"><span className="icon-box"><ChartNoAxesCombined size={20} /></span><span className="metric-label">Saldo estimado*</span><span className="metric">{costUnavailable ? '—' : money(totalRevenue - estimatedCost)}</span></div>
    </div>
    <div className="two">
      <section className="card"><h2 className="section-title">Últimas encomendas</h2><p className="muted">Pedidos cadastrados recentemente</p>{data.orders.length ? <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Entrega</th><th>Valor</th><th>Status</th></tr></thead><tbody>{data.orders.slice(-5).reverse().map(o => <tr key={o.id}><td>{o.customer}</td><td>{brDate(o.deliveryDate)}</td><td>{money(o.quantity * o.unitPrice)}</td><td><span className="tag">{o.status}</span></td></tr>)}</tbody></table></div> : <div className="empty"><ClipboardCheck size={30} />Nenhuma encomenda cadastrada ainda.</div>}</section>
      <section className="card"><h2 className="section-title">Primeiros passos</h2><p className="muted">Configure suas informações para começar</p><div className="stack" style={{ marginTop: 23 }}>{steps.map(x => <button key={x.label} className="secondary" onClick={() => focus(x.pg)} style={{ justifyContent: 'space-between', width: '100%', textAlign: 'left' }}>{x.label}{x.ok ? <CheckCircle2 size={18} color="#16794a" /> : <ArrowRight size={16} />}</button>)}</div></section>
    </div>
    <p className="footnote">*Indicadores estimados: saldos ainda não representam lucro líquido, fluxo de caixa nem impostos efetivos. Para esta versão, o sinal recebido é usado apenas no valor a receber.{costUnavailable ? ' O saldo estimado não é exibido porque há receita de pedido confirmado sem custo calculável (falta alguma equivalência de medida).' : ''}{!costUnavailable && withoutRecord > 0 ? ` ${withoutRecord} pedido(s) antigo(s) não têm custo registrado e entram com o custo atual da receita (estimativa).` : ''}</p>
  </>;
}
