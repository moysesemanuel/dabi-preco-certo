import { useMemo, useState, type FormEvent } from 'react';
import { ClipboardCheck, FileText, Pencil, Plus, Save, X } from 'lucide-react';
import { updateOrder } from '../domain/edit';
import { money } from '../domain/pricing';
import type { Order } from '../domain/types';
import { Field } from '../components/Field';
import { brDate, newId, parse, priceRecipe, type PageProps } from '../utils';

const statuses: Order['status'][] = ['Orçamento', 'Confirmado', 'Produção', 'Entregue'];

export function OrdersPage({ data, update, inform }: PageProps) {
  const [customer, setCustomer] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [qty, setQty] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [deposit, setDeposit] = useState('0');
  const [date, setDate] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetForm() { setEditingId(null); setCustomer(''); setRecipeId(''); setQty('1'); setUnitPrice(''); setDeposit('0'); setDate(''); }
  function startEdit(id: string) {
    const o = data.orders.find(x => x.id === id);
    if (!o) return;
    setEditingId(o.id); setCustomer(o.customer); setRecipeId(o.recipeId); setQty(String(o.quantity)); setUnitPrice(String(o.unitPrice)); setDeposit(String(o.deposit)); setDate(o.deliveryDate);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveOrder(e: FormEvent) {
    e.preventDefault();
    const q = parse(qty), price = parse(unitPrice), dep = parse(deposit);
    if (!customer.trim() || !recipeId || !date || !(q > 0) || !(price >= 0) || !(dep >= 0) || dep > q * price || ![q, price, dep].every(Number.isFinite)) return inform('Revise cliente, receita, data, quantidade, preço e sinal.');
    if (editingId) {
      try { update(d => updateOrder(d, editingId, { customer, recipeId, quantity: q, unitPrice: price, deliveryDate: date, deposit: dep })); } catch (err) { return inform(err instanceof Error ? err.message : 'Não foi possível atualizar a encomenda.'); }
      resetForm(); inform('Encomenda atualizada. Status e data de criação foram mantidos.');
      return;
    }
    const order: Order = { id: newId(), customer: customer.trim(), recipeId, quantity: q, unitPrice: price, deliveryDate: date, deposit: dep, status: 'Orçamento', createdAt: new Date().toISOString() };
    update(d => ({ ...d, orders: [...d.orders, order] }));
    setCustomer(''); setDeposit('0'); inform('Encomenda cadastrada.');
  }
  const copyQuote = async (o: Order) => {
    const r = data.recipes.find(x => x.id === o.recipeId);
    const txt = `Olá, ${o.customer}! Segue seu orçamento:\nProduto: ${r?.name ?? 'Encomenda'}\nQuantidade: ${o.quantity}\nValor unitário: ${money(o.unitPrice)}\nTotal: ${money(o.quantity * o.unitPrice)}\nData solicitada: ${brDate(o.deliveryDate)}\nCondições de pagamento e disponibilidade sujeitas à confirmação.`;
    try { await navigator.clipboard.writeText(txt); inform('Orçamento copiado para enviar no WhatsApp.'); } catch { inform('Não foi possível copiar automaticamente.'); }
  };
  const orderCost = useMemo(() => { const r = data.recipes.find(x => x.id === recipeId); return r ? priceRecipe(r, data) : null; }, [data, recipeId]);

  return <>
    <div className="head"><div><div className="eyebrow">Atendimento e organização</div><h1>Encomendas</h1><p className="muted">Cadastre pedidos, acompanhe estados e copie orçamentos.</p></div></div>
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
          {recipeId && orderCost?.ok && <div className="notice">Custo estimado por unidade: <strong>{money(orderCost.cost.costPerUnit)}</strong>. Valor unitário pode ser ajustado conforme a negociação.</div>}
          {recipeId && orderCost && !orderCost.ok && <div className="notice warn"><strong>Custo indisponível.</strong> {orderCost.message} Informe o preço unitário manualmente ou corrija o cadastro.</div>}
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" disabled={!data.recipes.length} type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Registrar encomenda</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="card"><h2 className="section-title">Pedidos ({data.orders.length})</h2>
        {data.orders.length ? <div className="stack" style={{ marginTop: 16 }}>{data.orders.slice().reverse().map(o => <div key={o.id} style={{ border: '1px solid #e6eaf0', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 9 }}><div><strong>{o.customer}</strong><p className="muted">{data.recipes.find(r => r.id === o.recipeId)?.name ?? 'Receita indisponível'} · {o.quantity} un.</p></div><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span className="tag">{o.status}</span><button aria-label={`Editar encomenda de ${o.customer}`} title="Editar" className="inline-icon" onClick={() => startEdit(o.id)}><Pencil size={15} /></button></div></div>
          <div className="formula-row" style={{ margin: '10px 0' }}><span>Valor: {money(o.quantity * o.unitPrice)}</span><strong>Entrega: {brDate(o.deliveryDate)}</strong></div>
          <div className="form-grid">
            <Field label="Status"><select value={o.status} onChange={e => update(d => ({ ...d, orders: d.orders.map(x => x.id === o.id ? { ...x, status: e.target.value as Order['status'] } : x) }))}>{statuses.map(s => <option key={s}>{s}</option>)}</select></Field>
            <div style={{ alignSelf: 'end' }}><button className="secondary" onClick={() => copyQuote(o)} style={{ width: '100%' }}><FileText size={16} /> Copiar orçamento</button></div>
          </div>
        </div>)}</div> : <div className="empty"><ClipboardCheck size={30} />Nenhum pedido cadastrado.</div>}
      </section>
    </div>
    <p className="footnote">O status não representa confirmação de pagamento ou disponibilidade. Confirme valores, sinal e prazo diretamente com o cliente.</p>
  </>;
}
