import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Save, ShoppingBasket, Trash2, X } from 'lucide-react';
import { unitChangeAffectsRecipes, updateIngredient } from '../domain/edit';
import { money } from '../domain/pricing';
import type { Unit } from '../domain/types';
import { Field } from '../components/Field';
import { newId, parse, units, type PageProps } from '../utils';

export function IngredientsPage({ data, update, inform }: PageProps) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [qty, setQty] = useState('1000');
  const [price, setPrice] = useState('');
  const [cupGrams, setCupGrams] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetForm() { setEditingId(null); setName(''); setUnit('g'); setQty('1000'); setPrice(''); setCupGrams(''); }
  function startEdit(id: string) {
    const i = data.ingredients.find(x => x.id === id);
    if (!i) return;
    setEditingId(i.id); setName(i.name); setUnit(i.unit); setQty(String(i.purchaseQuantity)); setPrice(String(i.purchasePrice)); setCupGrams(i.gramsPerCup ? String(i.gramsPerCup) : '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveIngredient(e: FormEvent) {
    e.preventDefault();
    const quantity = parse(qty), p = parse(price);
    if (!name.trim() || !(quantity > 0) || !(p >= 0) || !Number.isFinite(p)) return inform('Preencha nome, quantidade positiva e preço válido.');
    const weighed = unit === 'g' || unit === 'kg';
    const cup = cupGrams.trim() && weighed ? parse(cupGrams) : undefined;
    if (cup !== undefined && !(cup > 0)) return inform('Informe um peso válido para 1 xícara (maior que zero) ou deixe em branco.');
    const values = { name: name.trim(), unit, purchaseQuantity: quantity, purchasePrice: p, ...(cup ? { gramsPerCup: cup } : {}) };
    if (editingId) {
      const unitWarning = unitChangeAffectsRecipes(data, editingId, unit);
      update(d => updateIngredient(d, editingId, values));
      resetForm();
      inform(unitWarning ? 'Ingrediente atualizado. Atenção: você mudou a unidade; revise as quantidades nas receitas que o usam.' : 'Ingrediente atualizado. Os custos das receitas foram recalculados.');
      return;
    }
    update(d => ({ ...d, ingredients: [...d.ingredients, { id: newId(), ...values }] }));
    setName(''); setPrice(''); setCupGrams(''); inform('Ingrediente cadastrado.');
  }
  function removeIngredient(ingredientId: string) {
    if (data.recipes.some(r => r.items.some(i => i.ingredientId === ingredientId))) return inform('Este ingrediente está em uma receita. Remova a referência antes.');
    if (!confirm('Excluir este ingrediente?')) return;
    update(d => ({ ...d, ingredients: d.ingredients.filter(i => i.id !== ingredientId) }));
    if (editingId === ingredientId) resetForm();
  }

  return <>
    <div className="head"><div><div className="eyebrow">Base de custos</div><h1>Ingredientes</h1><p className="muted">Cadastre quanto você paga pela embalagem inteira, antes de montar suas receitas.</p></div></div>
    <div className="two">
      <section className="card"><h2 className="section-title">{editingId ? 'Editar ingrediente' : 'Novo ingrediente'}</h2>
        <form onSubmit={saveIngredient} className="stack" style={{ marginTop: 19 }}>
          <Field label="Nome do ingrediente"><input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Farinha de trigo" required /></Field>
          <div className="form-grid">
            <Field label="Quantidade comprada"><input type="number" min="0.001" step="any" value={qty} onChange={e => setQty(e.target.value)} required /></Field>
            <Field label="Unidade"><select value={unit} onChange={e => setUnit(e.target.value as Unit)}>{units.map(u => <option key={u}>{u}</option>)}</select></Field>
          </div>
          <Field label="Preço pago (R$)"><input type="number" min="0" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="Ex.: 6.90" required /></Field>
          {(unit === 'g' || unit === 'kg') && <Field label="1 xícara pesa quantos gramas? (opcional)"><input type="number" min="0.1" step="any" value={cupGrams} onChange={e => setCupGrams(e.target.value)} placeholder="Ex.: 120" /></Field>}
          <p className="form-subtitle">Exemplo: 1000 g de farinha por R$ 6,90. {(unit === 'g' || unit === 'kg') ? 'Informar o peso de 1 xícara permite usar xícaras e colheres nas receitas.' : ''}</p>
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Adicionar ingrediente</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="card"><h2 className="section-title">Ingredientes cadastrados ({data.ingredients.length})</h2>
        {data.ingredients.length ? <div className="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Compra</th><th>Preço</th><th></th></tr></thead><tbody>{data.ingredients.map(i => <tr key={i.id}><td>{i.name}</td><td>{i.purchaseQuantity} {i.unit}{i.gramsPerCup ? <div className="muted" style={{ fontSize: 12 }}>1 xícara = {i.gramsPerCup} g</div> : null}</td><td>{money(i.purchasePrice)}</td><td style={{ whiteSpace: 'nowrap' }}><button aria-label={`Editar ${i.name}`} title="Editar" className="inline-icon" onClick={() => startEdit(i.id)}><Pencil size={15} /></button><button aria-label={`Excluir ${i.name}`} title="Excluir" className="inline-icon" onClick={() => removeIngredient(i.id)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty"><ShoppingBasket size={30} />Sua lista de ingredientes aparecerá aqui.</div>}
      </section>
    </div>
    <p className="footnote">Na receita você pode usar g, kg, ml, l, xícara e colheres; o app converte para a unidade de compra. Para converter xícara ou colher em peso, informe quanto pesa 1 xícara do ingrediente (xícara = 240 ml, colher de sopa = 15 ml, colher de chá = 5 ml).</p>
  </>;
}
