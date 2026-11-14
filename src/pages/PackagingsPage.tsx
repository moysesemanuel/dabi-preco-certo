import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { MoneyInput } from '../components/MoneyInput';
import { Field } from '../components/Field';
import { parseMoneyInput, isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { money, moneyPrecise } from '../domain/pricing';
import type { Packaging } from '../domain/types';
import { newId, type PageProps } from '../utils';


export function PackagingsPage({ data, update, inform }: PageProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(''); const [price, setPrice] = useState(''); const [quantity, setQuantity] = useState(''); const [capacity, setCapacity] = useState('');
  const reset = () => { setEditing(null); setName(''); setPrice(''); setQuantity(''); setCapacity(''); };
  const startEdit = (item: Packaging) => { setEditing(item.id); setName(item.name); setPrice(String(item.purchasePrice)); setQuantity(String(item.purchaseQuantity)); setCapacity(item.capacity === undefined ? '' : String(item.capacity)); };
  function save(e: FormEvent) {
    e.preventDefault();
    const parsedPrice = parseMoneyInput(price); const p = parsedPrice === undefined ? Number.NaN : toCents2(parsedPrice);
    const q = Number(quantity.replace(',', '.')); const c = capacity.trim() ? Number(capacity.replace(',', '.')) : undefined;
    if (!name.trim() || !isMoney(p) || !isPositiveQuantity(q) || (c !== undefined && !isPositiveQuantity(c))) return inform('Informe nome, preço válido, quantidade comprada positiva e capacidade válida.');
    const old = editing ? data.packagings.find(x => x.id === editing) : undefined;
    const next: Packaging = { id: editing ?? newId(), name: name.trim(), purchasePrice: p, purchaseQuantity: q, ...(c !== undefined ? { capacity: c } : {}), active: old?.active ?? true };
    update(d => ({ ...d, packagings: editing ? d.packagings.map(x => x.id === editing ? { ...x, ...next } : x) : [...d.packagings, next] }));
    reset(); inform(editing ? 'Embalagem atualizada.' : 'Embalagem cadastrada.');
  }
  function remove(item: Packaging) {
    const used = data.recipes.some(r => r.packagingItems?.some(x => x.packagingId === item.id)) || data.orders.some(o => o.packagingItems?.some(x => x.packagingId === item.id));
    if (used) { update(d => ({ ...d, packagings: d.packagings.map(x => x.id === item.id ? { ...x, active: false } : x) })); inform('Embalagem desativada. Os vínculos e snapshots existentes foram preservados.'); return; }
    if (!confirm(`Excluir “${item.name}”?`)) return;
    update(d => ({ ...d, packagings: d.packagings.filter(x => x.id !== item.id) }));
  }
  const parsed = parseMoneyInput(price); const q = Number(quantity.replace(',', '.'));
  return <>
    <div className="head"><div><div className="eyebrow">Base de custos</div><h1>Embalagens</h1><p className="muted">Cadastre pacotes e acompanhe o custo de cada unidade.</p></div></div>
    <section className="card stack"><h2 className="section-title">{editing ? 'Editar embalagem' : 'Cadastrar embalagem'}</h2>
      <form className="stack" onSubmit={save}><div className="form-grid">
        <Field label="Nome"><input value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="Ex.: Forminha de papel" required /></Field>
        <Field label="Preço total da compra"><MoneyInput value={price} onValueChange={setPrice} required /></Field>
        <Field label="Quantidade comprada (unidades)"><input type="number" min="0.001" step="any" inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} required /></Field>
        <Field label="Capacidade opcional (produtos por embalagem)"><input type="number" min="0.001" step="any" inputMode="decimal" value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="Ex.: 25" /></Field>
      </div>
      <p className="notice">Custo unitário: <strong>{isMoney(parsed) && isPositiveQuantity(q) ? moneyPrecise(parsed / q) : '—'}</strong> (mantemos a precisão integral no cálculo).</p>
      <div className="actions"><button className="primary" type="submit">{editing ? <><Save size={16} /> Salvar</> : <><Plus size={16} /> Cadastrar</>}</button>{editing && <button className="secondary" type="button" onClick={reset}><X size={16} /> Cancelar</button>}</div></form>
    </section>
    <section className="card" style={{ marginTop: 18 }}><h2 className="section-title">Embalagens cadastradas</h2>{data.packagings.length ? <div className="table-wrap"><table><thead><tr><th>Embalagem</th><th>Compra</th><th>Custo unitário</th><th>Capacidade</th><th>Status</th><th /></tr></thead><tbody>{data.packagings.map(p => <tr key={p.id}><td>{p.name}</td><td>{money(p.purchasePrice)} / {p.purchaseQuantity} un.</td><td>{moneyPrecise(p.purchasePrice / p.purchaseQuantity)}</td><td>{p.capacity ? `${p.capacity} produtos` : '—'}</td><td>{p.active ? 'Ativa' : 'Desativada'}</td><td>{!p.active && <button className="secondary" onClick={() => { update(d => ({ ...d, packagings: d.packagings.map(x => x.id === p.id ? { ...x, active: true } : x) })); inform('Embalagem reativada para novas associações.'); }}>Reativar</button>}<button className="inline-icon" aria-label={`Editar ${p.name}`} onClick={() => startEdit(p)}><Pencil size={15} /></button><button className="inline-icon" aria-label={`${p.active ? 'Desativar ou excluir' : 'Excluir'} ${p.name}`} onClick={() => remove(p)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty">Suas embalagens aparecerão aqui.</div>}</section>
  </>;
}
