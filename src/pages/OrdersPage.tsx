import { useAccount } from '../account/AccountContext';
import { useMemo, useState, type FormEvent } from 'react';
import { ClipboardCheck, FileText, Link2, Pencil, Plus, Save, Trash2, Wallet, X } from 'lucide-react';
import { removeOrder, updateOrder } from '../domain/edit';
import { captureCostSnapshot, orderUnitCost } from '../domain/orderCost';
import { isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { money } from '../domain/pricing';
import { addPayment, balanceDue, orderTotal, removePayment, totalReceived } from '../domain/payments';
import { PAYMENT_METHODS, type Order, type PaymentMethod } from '../domain/types';
import { Field } from '../components/Field';
import { OrderSearch } from '../components/OrderSearch';
import { QuoteCode } from '../components/QuoteCode';
import { filterOrders } from '../domain/orderSearch';
import { effectiveQuoteCodes, uniqueQuoteCode } from '../../shared/quoteCode';
import { QuoteSharePanel } from '../features/sharing/QuoteSharePanel';
import { FORECAST_DISCLAIMER, forecastUntil, formatMinutes } from '../domain/schedule';
import { brDate, localToday, newId, parse, priceRecipe, tryApply, type PageProps } from '../utils';

const statuses: Order['status'][] = ['Orçamento', 'Confirmado', 'Produção', 'Entregue'];

/** Aviso permanente enquanto houver recebimentos lançados aqui que ainda aguardam reconciliação. */
function FinancialPendingNotice({ focus }: { focus: PageProps['focus'] }) {
  const acc = useAccount();
  if (!acc.openFinancial) return null;
  return <div className="notice warn" role="alert"><strong>{acc.openFinancial === 1 ? 'Há um recebimento aguardando reconciliação.' : `Há ${acc.openFinancial} encomendas com recebimentos aguardando reconciliação.`}</strong> Foram lançados neste dispositivo, mas a encomenda mudou em outro. Nada foi descartado. <button className="secondary" onClick={() => focus('settings')}>Resolver em Configurações</button></div>;
}

export function OrdersPage({ data, update, inform, focus }: PageProps) {
  const [customer, setCustomer] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [qty, setQty] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [deposit, setDeposit] = useState('0');
  const [date, setDate] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [quotingId, setQuotingId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod | ''>('');
  const [payNote, setPayNote] = useState('');
  const [query, setQuery] = useState('');
  // Código permanente de atendimento de cada pedido (os antigos, sem código, recebem o derivado do id).
  const codes = useMemo(() => effectiveQuoteCodes(data.orders), [data.orders]);
  const visible = useMemo(() => filterOrders(data.orders, query, { codes, productOf: o => data.recipes.find(r => r.id === o.recipeId)?.name ?? '' }), [data.orders, data.recipes, codes, query]);

  function resetForm() { setEditingId(null); setCustomer(''); setRecipeId(''); setQty('1'); setUnitPrice(''); setDeposit('0'); setDate(''); }
  function startEdit(id: string) {
    const o = data.orders.find(x => x.id === id);
    if (!o) return;
    setEditingId(o.id); setCustomer(o.customer); setRecipeId(o.recipeId); setQty(String(o.quantity)); setUnitPrice(String(o.unitPrice)); setDeposit(String(o.deposit)); setDate(o.deliveryDate);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function deleteOrder(o: Order) {
    if (!confirm(`Excluir a encomenda de ${o.customer} (${money(o.quantity * o.unitPrice)})? Esta ação não pode ser desfeita.`)) return;
    const failedDelete = tryApply(data, update, d => removeOrder(d, o.id));
    if (failedDelete) return inform(failedDelete);
    if (editingId === o.id) resetForm();
    inform('Encomenda excluída.');
  }
  function saveOrder(e: FormEvent) {
    e.preventDefault();
    const q = parse(qty), price = toCents2(parse(unitPrice)), dep = toCents2(parse(deposit));
    if (!customer.trim() || !recipeId || !date || !isPositiveQuantity(q) || !isMoney(price) || !isMoney(dep) || dep > toCents2(q * price)) return inform('Revise cliente, receita, data, quantidade, preço e sinal.');
    if (editingId) {
      const failed = tryApply(data, update, d => updateOrder(d, editingId, { customer, recipeId, quantity: q, unitPrice: price, deliveryDate: date, deposit: dep }));
      if (failed) return inform(failed);
      resetForm(); inform('Encomenda atualizada. Status e data de criação foram mantidos.');
      return;
    }
    const now = new Date();
    // Registra o custo de hoje: ele não muda quando ingredientes ou a receita forem alterados depois.
    const snapshot = captureCostSnapshot(data.recipes.find(r => r.id === recipeId)!, data, now);
    const order: Order = { id: newId(), quoteCode: uniqueQuoteCode(new Set(codes.values())), customer: customer.trim(), recipeId, quantity: q, unitPrice: price, deliveryDate: date, deposit: dep, status: 'Orçamento', createdAt: now.toISOString(), ...(snapshot ? { costSnapshot: snapshot } : {}) };
    update(d => ({ ...d, orders: [...d.orders, order] }));
    setCustomer(''); setDeposit('0'); inform('Encomenda cadastrada.');
  }
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function openPayment(o: Order) { setPayingId(payingId === o.id ? null : o.id); setPayAmount(balanceDue(o) > 0 ? String(balanceDue(o)) : ''); setPayDate(todayIso()); setPayMethod(''); setPayNote(''); }
  function savePayment(e: FormEvent, o: Order) {
    e.preventDefault();
    const amount = toCents2(parse(payAmount));
    const failed = tryApply(data, update, d => addPayment(d, o.id, { id: newId(), amount, receivedAt: payDate, ...(payMethod ? { method: payMethod } : {}), ...(payNote.trim() ? { note: payNote.trim() } : {}) }));
    if (failed) return inform(failed);
    setPayingId(null); inform('Recebimento registrado.');
  }
  function deletePayment(o: Order, paymentId: string) {
    if (!confirm('Remover este recebimento? O saldo pendente da encomenda voltará a aumentar.')) return;
    const failed = tryApply(data, update, d => removePayment(d, o.id, paymentId));
    if (failed) return inform(failed);
    inform('Recebimento removido.');
  }
  const copyQuote = async (o: Order) => {
    const r = data.recipes.find(x => x.id === o.recipeId);
    const txt = `Olá, ${o.customer}! Segue seu orçamento ${codes.get(o.id)}:\nProduto: ${r?.name ?? 'Encomenda'}\nQuantidade: ${o.quantity}\nValor unitário: ${money(o.unitPrice)}\nTotal: ${money(o.quantity * o.unitPrice)}\nData solicitada: ${brDate(o.deliveryDate)}\nCondições de pagamento e disponibilidade sujeitas à confirmação.`;
    try { await navigator.clipboard.writeText(txt); inform('Orçamento copiado para enviar no WhatsApp.'); } catch { inform('Não foi possível copiar automaticamente.'); }
  };
  const orderCost = useMemo(() => { const r = data.recipes.find(x => x.id === recipeId); return r ? priceRecipe(r, data) : null; }, [data, recipeId]);

  return <>
    <div className="head"><div><div className="eyebrow">Atendimento e organização</div><h1>Encomendas</h1><p className="muted">Cadastre pedidos, acompanhe estados e copie orçamentos.</p></div></div>
    <FinancialPendingNotice focus={focus} />
    <div className="two">
      <section className="card"><h2 className="section-title">{editingId ? 'Editar encomenda' : 'Nova encomenda'}</h2>
        <form className="stack" onSubmit={saveOrder} style={{ marginTop: 19 }}>
          <Field label="Nome do cliente"><input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Ex.: Ana Martins" required /></Field>
          <Field label="Receita"><select value={recipeId} onChange={e => { const newRecipe = e.target.value; setRecipeId(newRecipe); if (editingId) return; /* ao editar, não sobrescreve o preço negociado */ const r = data.recipes.find(x => x.id === newRecipe); const result = r ? priceRecipe(r, data) : null; setUnitPrice(result?.ok ? String(result.cost.suggestedPrice) : ''); }} required><option value="">Escolha a receita...</option>{data.recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <div className="form-grid">
            <Field label="Quantidade"><input type="number" min="0.01" step="any" value={qty} onChange={e => setQty(e.target.value)} required /></Field>
            <Field label="Preço unitário (R$)"><input type="number" min="0" step="any" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} required /></Field>
            <Field label="Data da entrega"><input type="date" value={date} onChange={e => setDate(e.target.value)} required /></Field>
            <Field label="Sinal recebido (R$)"><input type="number" min="0" step="any" value={deposit} onChange={e => setDeposit(e.target.value)} required /></Field>
          </div>
          {(() => {
            const q = parse(qty);
            if (!recipeId || !date || !isPositiveQuantity(q)) return null;
            const f = forecastUntil({ ...data, orders: data.orders.filter(o => o.id !== editingId) }, localToday(), date, { recipeId, quantity: q });
            const text = f.status === 'unknown'
              ? ({ 'no-capacity': 'Informe a capacidade diária em Configurações para estimar o prazo.', 'no-prep-time': 'Informe o tempo de produção na receita para estimar o prazo.', 'past-date': 'A data de entrega já passou.', invalid: 'Data inválida.' })[f.reason ?? 'invalid']
              : `${({ ok: 'Com folga', tight: 'Apertado', overload: 'Sobrecarga' })[f.status]}: carga de ${formatMinutes(f.requiredMinutes)} para ${formatMinutes(f.availableMinutes)} disponíveis até essa data.`;
            return <div className={f.status === 'overload' ? 'notice error' : f.status === 'tight' ? 'notice warn' : 'notice'}><strong>Estimativa de prazo.</strong> {text} <span style={{ opacity: .8 }}>{FORECAST_DISCLAIMER}</span></div>;
          })()}
          {recipeId && orderCost?.ok && <div className="notice">Custo estimado por unidade: <strong>{money(orderCost.cost.costPerUnit)}</strong>. Valor unitário pode ser ajustado conforme a negociação.</div>}
          {recipeId && orderCost && !orderCost.ok && <div className="notice warn"><strong>Custo indisponível.</strong> {orderCost.message} Informe o preço unitário manualmente ou corrija o cadastro.</div>}
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" disabled={!data.recipes.length} type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Registrar encomenda</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="card"><div className="list-head"><h2 className="section-title">Pedidos ({query.trim() ? `${visible.length} de ${data.orders.length}` : data.orders.length})</h2>{data.orders.length > 0 && <OrderSearch value={query} onChange={setQuery} />}</div>
        {data.orders.length && !visible.length ? <div className="empty" role="status"><ClipboardCheck size={30} />Nenhum pedido encontrado para “{query.trim()}”.<br /><button type="button" className="secondary" style={{ marginTop: 10 }} onClick={() => setQuery('')}>Mostrar todos os pedidos</button></div> : null}
        {visible.length ? <div className="stack" style={{ marginTop: 16 }}>{visible.slice().reverse().map(o => <div key={o.id} style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 9, flexWrap: 'wrap' }}><div style={{ minWidth: 0 }}><QuoteCode code={codes.get(o.id)!} /><strong>{o.customer}</strong><p className="muted">{data.recipes.find(r => r.id === o.recipeId)?.name ?? 'Receita indisponível'} · {o.quantity} un.</p></div><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span className="tag">{o.status}</span><button aria-label={`Editar encomenda de ${o.customer}`} title="Editar" className="inline-icon" onClick={() => startEdit(o.id)}><Pencil size={15} /></button><button aria-label={`Excluir encomenda de ${o.customer}`} title="Excluir" className="inline-icon" onClick={() => deleteOrder(o)}><Trash2 size={15} /></button></div></div>
          <div className="formula-row" style={{ margin: '10px 0' }}><span>Valor: {money(orderTotal(o))}</span><strong>Entrega: {brDate(o.deliveryDate)}</strong></div>
          <div className="formula-row" style={{ margin: '0 0 8px', fontSize: 13 }}><span>Recebido: <strong>{money(totalReceived(o))}</strong></span><span>Saldo pendente: <strong style={{ color: balanceDue(o) > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>{money(balanceDue(o))}</strong></span></div>
          {o.status === 'Entregue' && balanceDue(o) > 0 && <div className="notice warn" style={{ marginBottom: 8 }}>Entregue com saldo pendente de {money(balanceDue(o))}.</div>}
          {(o.deposit > 0 || (o.payments ?? []).length > 0) && <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, fontSize: 12, color: 'var(--color-muted-text)' }}>
            {o.deposit > 0 && <li style={{ display: 'flex', justifyContent: 'space-between' }}><span>Sinal</span><span>{money(o.deposit)}</span></li>}
            {(o.payments ?? []).map(p => <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span>{brDate(p.receivedAt)}{p.method ? ` · ${p.method}` : ''}{p.note ? ` · ${p.note}` : ''}</span><span>{money(p.amount)} <button aria-label={`Remover recebimento de ${money(p.amount)}`} title="Remover" className="inline-icon" style={{ width: 28, height: 28 }} onClick={() => deletePayment(o, p.id)}><Trash2 size={13} /></button></span></li>)}
          </ul>}
          {balanceDue(o) > 0 && <button type="button" className="secondary" style={{ width: '100%', marginBottom: 8 }} onClick={() => openPayment(o)}><Wallet size={16} /> {payingId === o.id ? 'Fechar' : 'Registrar recebimento'}</button>}
          {payingId === o.id && <form className="stack" style={{ marginBottom: 10 }} onSubmit={e => savePayment(e, o)}>
            <div className="form-grid">
              <Field label="Valor recebido (R$)"><input type="number" min="0.01" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} required /></Field>
              <Field label="Data do recebimento"><input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required /></Field>
              <Field label="Meio de pagamento (opcional)"><select value={payMethod} onChange={e => setPayMethod(e.target.value as PaymentMethod | '')}><option value="">Não informar</option>{PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Observação (opcional)"><input value={payNote} maxLength={200} onChange={e => setPayNote(e.target.value)} placeholder="Ex.: 2ª parcela" /></Field>
            </div>
            <p className="form-subtitle" style={{ margin: 0 }}>Saldo pendente: {money(balanceDue(o))}. Não é possível receber mais do que o saldo.</p>
            <button className="primary" type="submit"><Save size={16} /> Registrar recebimento</button>
          </form>}
          {(() => { const c = orderUnitCost(o, data); return <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>{c.basis === 'recorded' ? `Custo registrado no pedido: ${money(c.costPerUnit)} por unidade.` : c.basis === 'estimated' ? `Custo estimado com os preços atuais: ${money(c.costPerUnit)} por unidade (pedido sem custo registrado).` : 'Custo indisponível para este pedido.'}</p>; })()}
          <div className="form-grid">
            <Field label="Status"><select value={o.status} onChange={e => update(d => ({ ...d, orders: d.orders.map(x => x.id === o.id ? { ...x, status: e.target.value as Order['status'] } : x) }))}>{statuses.map(s => <option key={s}>{s}</option>)}</select></Field>
            <div style={{ alignSelf: 'end', display: 'grid', gap: 6 }}><button className="secondary" onClick={() => copyQuote(o)} style={{ width: '100%' }}><FileText size={16} /> Copiar orçamento</button><button className="secondary" onClick={() => setQuotingId(quotingId === o.id ? null : o.id)} style={{ width: '100%' }}><Link2 size={16} /> {quotingId === o.id ? 'Fechar orçamento' : 'Orçamento por link'}</button></div>
          </div>
          {quotingId === o.id && <QuoteSharePanel order={o} code={codes.get(o.id)!} data={data} update={update} inform={inform} focus={focus} onClose={() => setQuotingId(null)} />}
        </div>)}</div> : !data.orders.length ? <div className="empty"><ClipboardCheck size={30} />Nenhum pedido cadastrado.</div> : null}
      </section>
    </div>
    <p className="footnote">O status não representa confirmação de pagamento ou disponibilidade. Confirme valores, sinal e prazo diretamente com o cliente.</p>
  </>;
}
