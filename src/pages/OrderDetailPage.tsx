import { useState, type FormEvent } from 'react';
import { ArrowLeft, FileText, Link2, Pencil, Save, Trash2, Wallet } from 'lucide-react';
import { addPayment, balanceDue, orderTotal, removePayment, totalReceived } from '../domain/payments';
import { orderPackagingTotal, orderTotalCost, orderUnitCost } from '../domain/orderCost';
import { calculateOrderFinancials } from '../domain/orderFinancials';
import { parseMoneyInput, toCents2 } from '../domain/money';
import { money } from '../domain/pricing';
import type { Order, PaymentMethod } from '../domain/types';
import { PAYMENT_METHODS } from '../domain/types';
import { Field } from '../components/Field';
import { MoneyInput } from '../components/MoneyInput';
import { QuoteCode } from '../components/QuoteCode';
import { QuoteSharePanel } from '../features/sharing/QuoteSharePanel';
import { PublishedLinks } from '../features/sharing/PublishedLinks';
import { FinancialPendingNotice } from '../features/orders/FinancialPendingNotice';
import { OrderForm } from '../features/orders/OrderForm';
import { effectiveQuoteCodes } from '../../shared/quoteCode';
import { brDate, newId, tryApply, type PageProps } from '../utils';
import { useAccount } from '../account/AccountContext';

const statuses: Order['status'][] = ['Orçamento', 'Confirmado', 'Produção', 'Entregue'];
const statusLabel = (status: Order['status']) => status === 'Produção' ? 'Em produção' : status;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function OrderDetailPage({ data, update, inform, focus, openOrder, orderId }: PageProps & { orderId: string }) {
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [publishedLinksOpen, setPublishedLinksOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(today());
  const [payMethod, setPayMethod] = useState<PaymentMethod | ''>('');
  const [payNote, setPayNote] = useState('');
  const order = data.orders.find(o => o.id === orderId);
  const account = useAccount();
  const code = order ? effectiveQuoteCodes(data.orders).get(order.id)! : '';

  if (!order) return <section className="card order-not-found"><h1>Pedido não encontrado</h1><p className="muted">Ele pode ter sido removido ou ainda não estar sincronizado neste dispositivo.</p><button className="secondary" onClick={() => focus('orders')}><ArrowLeft size={16} /> Voltar para Pedidos</button></section>;
  const currentOrder = order;

  const product = data.recipes.find(r => r.id === order.recipeId);
  const received = totalReceived(order);
  const due = balanceDue(order);
  const cost = orderUnitCost(order, data);
  const costTotal = orderTotalCost(order, data);
  const financials = calculateOrderFinancials({
    quantity: order.quantity, unitPrice: order.unitPrice, packagingCharge: order.packagingCharge ?? 0,
    recipeCostPerUnit: cost.basis === 'unavailable' ? undefined : cost.costPerUnit,
    additionalPackagingCost: orderPackagingTotal(order), received,
  });
  const quoteCodes = effectiveQuoteCodes(data.orders);

  function copyQuote() {
    const text = `Olá, ${currentOrder.customer}! Segue seu orçamento ${code}:\nProduto: ${product?.name ?? 'Encomenda'}\nQuantidade: ${currentOrder.quantity}\nValor unitário: ${money(currentOrder.unitPrice)}\nTotal: ${money(orderTotal(currentOrder))}\nData solicitada: ${brDate(currentOrder.deliveryDate)}\nCondições de pagamento e disponibilidade sujeitas à confirmação.`;
    void navigator.clipboard.writeText(text).then(() => inform('Orçamento copiado para enviar no WhatsApp.')).catch(() => inform('Não foi possível copiar automaticamente.'));
  }

  function deleteOrder() {
    if (!confirm(`Excluir o pedido de ${currentOrder.customer} (${money(orderTotal(currentOrder))})? Esta ação não pode ser desfeita.`)) return;
    const next = { ...data, orders: data.orders.filter(o => o.id !== currentOrder.id) };
    update(() => next); inform('Pedido excluído.'); focus('orders');
  }

  function savePayment(e: FormEvent) {
    e.preventDefault();
    const parsed = parseMoneyInput(payAmount), amount = parsed === undefined ? Number.NaN : toCents2(parsed);
    const failed = tryApply(data, update, d => addPayment(d, currentOrder.id, { id: newId(), amount, receivedAt: payDate, ...(payMethod ? { method: payMethod } : {}), ...(payNote.trim() ? { note: payNote.trim() } : {}) }));
    if (failed) return inform(failed);
    setPaying(false); setPayAmount(''); inform('Recebimento registrado.');
  }

  function deletePayment(paymentId: string) {
    if (!confirm('Remover este recebimento? O saldo pendente do pedido voltará a aumentar.')) return;
    const failed = tryApply(data, update, d => removePayment(d, currentOrder.id, paymentId));
    if (failed) return inform(failed);
    inform('Recebimento removido.');
  }

  return <>
    <div className="head order-detail-head"><div><button className="back-link" onClick={() => focus('orders')}><ArrowLeft size={16} /> Pedidos</button><div className="eyebrow">Detalhes do pedido</div><h1>{order.customer}</h1><div className="muted"><QuoteCode code={code} /> · {product?.name ?? 'Receita indisponível'}</div></div>
      <div className="order-detail-actions"><button className="secondary" onClick={() => setEditing(v => !v)}><Pencil size={16} /> {editing ? 'Fechar edição' : 'Editar'}</button><button className="secondary danger" onClick={deleteOrder}><Trash2 size={16} /> Excluir pedido</button></div>
    </div>
    <FinancialPendingNotice focus={focus} />
    {editing ? <section className="card order-form-card"><h2 className="section-title">Editar pedido</h2><OrderForm key={order.id} data={data} update={update} inform={inform} focus={focus} openOrder={openOrder} initialOrder={order} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} /></section> : <div className="order-detail-grid">
      <section className="card order-detail-card" aria-labelledby="order-overview-heading">
        <div className="order-detail-card-head"><h2 id="order-overview-heading" className="section-title">Informações gerais</h2><span className="tag">{statusLabel(order.status)}</span></div>
        <dl className="order-detail-fields">
          <div><dt>Cliente</dt><dd>{order.customer}</dd></div><div><dt>Código ORC</dt><dd>{code}</dd></div>
          <div><dt>Receita</dt><dd>{product?.name ?? 'Receita indisponível'}</dd></div><div><dt>Quantidade</dt><dd>{order.quantity}</dd></div>
          <div><dt>Data de entrega</dt><dd>{brDate(order.deliveryDate)}</dd></div><div><dt>Status operacional</dt><dd><label className="sr-only" htmlFor="order-status">Status do pedido</label><select id="order-status" aria-label="Status" value={order.status} onChange={e => update(d => ({ ...d, orders: d.orders.map(o => o.id === order.id ? { ...o, status: e.target.value as Order['status'] } : o) }))}>{statuses.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></dd></div>
        </dl>
        {order.status === 'Entregue' && due > 0 && <div className="notice warn">Entregue com saldo pendente de {money(due)}. Status e situação financeira são independentes.</div>}
      </section>

      <section className="card order-detail-card" aria-labelledby="order-financial-heading">
        <h2 id="order-financial-heading" className="section-title">Composição financeira</h2>
        <div className="order-financial-summary">
          <div><span>Produtos · {order.quantity} × {money(order.unitPrice)}</span><strong>{money(financials.productsTotal)}</strong></div>
          <div><span>Embalagens adicionais cobradas</span><strong>{money(financials.packagingCharge)}</strong></div>
          <div className="order-financial-total"><span>Total da encomenda</span><strong>{money(orderTotal(order))}</strong></div>
          <div><span>Custo estimado</span><strong>{costTotal === undefined ? 'Indisponível' : money(costTotal)}</strong></div>
          <div><span>Lucro estimado</span><strong>{financials.estimatedProfit === undefined ? 'Indisponível' : money(financials.estimatedProfit)}</strong></div>
        </div>
        <h3>Embalagens incluídas pela receita</h3>
        {order.costSnapshot?.packagingItems?.length ? order.costSnapshot.packagingItems.map(p => <p className="muted" key={p.packagingId}>{p.name} · {p.quantityPerUnit} por unidade × {order.quantity} · custo congelado</p>) : <p className="muted">Sem snapshot de embalagens incluídas.</p>}
        <h3>Embalagens adicionais do pedido</h3>
        {order.packagingItems?.length ? order.packagingItems.map((p, index) => <p className="muted" key={`${p.packagingId}-${index}`}>{p.name} · {p.quantity} × {money(p.unitCost)} · custo congelado {money(toCents2(p.quantity * p.unitCost))}</p>) : <p className="muted">Nenhuma embalagem adicional registrada.</p>}
        {order.packagingItems?.length && !(order.packagingCharge ?? 0) ? <p className="form-subtitle">Este pedido é anterior à cobrança automática; as embalagens adicionais permanecem no custo, sem alterar o total histórico cobrado.</p> : null}
        <p className="form-subtitle">{cost.basis === 'recorded' ? `Custo unitário congelado em ${brDate(order.costSnapshot!.capturedAt.slice(0, 10))}.` : cost.basis === 'estimated' ? 'Custo estimado com os preços atuais; não há snapshot histórico.' : 'Custo não disponível para este pedido.'}</p>
      </section>

      <section className="card order-detail-card" aria-labelledby="order-payments-heading">
        <div className="order-detail-card-head"><h2 id="order-payments-heading" className="section-title">Pagamentos</h2><span className={due > 0 ? 'tag orange' : 'tag'}>Saldo {money(due)}</span></div>
        <div className="order-financial-summary"><div><span>Total recebido</span><strong>{money(received)}</strong></div><div className="order-financial-total"><span>Saldo pendente</span><strong>{money(due)}</strong></div></div>
        {order.deposit > 0 || order.payments?.length ? <ul className="order-payment-list">
          {order.deposit > 0 && <li><span>Sinal recebido · {brDate(order.createdAt.slice(0, 10))}</span><strong>{money(order.deposit)}</strong></li>}
          {(order.payments ?? []).map(p => <li key={p.id}><span>{brDate(p.receivedAt)}{p.method ? ` · ${p.method}` : ''}{p.note ? ` · ${p.note}` : ''}</span><strong>{money(p.amount)} <button className="inline-icon" aria-label={`Remover recebimento de ${money(p.amount)}`} onClick={() => deletePayment(p.id)}><Trash2 size={14} /></button></strong></li>)}
        </ul> : <p className="muted">Nenhum pagamento registrado até agora.</p>}
        {due > 0 && <>
          <button className="secondary" onClick={() => { setPaying(v => !v); setPayAmount(due > 0 ? String(due) : ''); setPayDate(today()); setPayMethod(''); setPayNote(''); }}><Wallet size={16} /> {paying ? 'Fechar recebimento' : 'Registrar recebimento'}</button>
          {paying && <form className="stack order-payment-form" onSubmit={savePayment}>
            <div className="form-grid"><Field label="Valor recebido (R$)"><MoneyInput value={payAmount} onValueChange={setPayAmount} required /></Field><Field label="Data do recebimento"><input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required /></Field><Field label="Meio de pagamento (opcional)"><select value={payMethod} onChange={e => setPayMethod(e.target.value as PaymentMethod | '')}><option value="">Não informar</option>{PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}</select></Field><Field label="Observação (opcional)"><input value={payNote} maxLength={200} onChange={e => setPayNote(e.target.value)} placeholder="Ex.: 2ª parcela" /></Field></div>
            <p className="form-subtitle">Saldo pendente: {money(due)}. Não é possível receber mais do que o saldo.</p><button className="primary" type="submit"><Save size={16} /> Registrar recebimento</button>
          </form>}
        </>}
      </section>

      <section className="card order-detail-card order-actions-card" aria-labelledby="order-actions-heading">
        <h2 id="order-actions-heading" className="section-title">Orçamento</h2>
        <button className="secondary" onClick={copyQuote}><FileText size={16} /> Copiar orçamento</button>
        <button className="secondary" onClick={() => setQuoteOpen(v => !v)}><Link2 size={16} /> {quoteOpen ? 'Fechar link público' : 'Compartilhar link público'}</button>
        {quoteOpen && <QuoteSharePanel order={order} code={quoteCodes.get(order.id)!} data={data} update={update} inform={inform} focus={focus} onClose={() => setQuoteOpen(false)} />}
        {account.entitled && <><button className="secondary" aria-expanded={publishedLinksOpen} onClick={() => setPublishedLinksOpen(v => !v)}><Link2 size={16} /> {publishedLinksOpen ? 'Fechar links publicados' : 'Gerenciar links publicados'}</button>{publishedLinksOpen && <PublishedLinks inform={inform} quoteNumber={code} />}</>}
      </section>
    </div>}
  </>;
}
