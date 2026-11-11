import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Save, ShoppingBasket, Trash2, X } from 'lucide-react';
import { unitChangeAffectsRecipes, updateIngredient } from '../domain/edit';
import { money } from '../domain/pricing';
import type { Unit } from '../domain/types';
import { Field } from '../components/Field';
import { densityToGramsPerCup, findReference, gramsPerCupToDensity, referenceDensity, REFERENCE_DISCLAIMER } from '../features/measurement/densities';
import { formatQuantity } from '../features/measurement/units';
import { isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { cupSizeOf, newId, parse, units, type PageProps } from '../utils';

export function IngredientsPage({ data, update, inform }: PageProps) {
  const cup = cupSizeOf(data);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [qty, setQty] = useState('1000');
  const [price, setPrice] = useState('');
  const [cupGrams, setCupGrams] = useState('');
  const [unitGrams, setUnitGrams] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const reference = findReference(name);
  const refDensity = reference ? referenceDensity(reference) : undefined;

  function resetForm() { setEditingId(null); setName(''); setUnit('g'); setQty('1000'); setPrice(''); setCupGrams(''); setUnitGrams(''); }
  function startEdit(id: string) {
    const i = data.ingredients.find(x => x.id === id);
    if (!i) return;
    setEditingId(i.id); setName(i.name); setUnit(i.unit); setQty(String(i.purchaseQuantity)); setPrice(String(i.purchasePrice));
    setCupGrams(i.densityGPerMl ? String(Number(densityToGramsPerCup(i.densityGPerMl, cup).toFixed(2))) : '');
    setUnitGrams(i.gramsPerUnit ? String(i.gramsPerUnit) : '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveIngredient(e: FormEvent) {
    e.preventDefault();
    const quantity = parse(qty), p = toCents2(parse(price));
    if (!name.trim() || !isPositiveQuantity(quantity) || !isMoney(p)) return inform('Preencha nome, quantidade positiva e preço válido.');
    const cupValue = cupGrams.trim() ? parse(cupGrams) : undefined;
    const unitValue = unitGrams.trim() ? parse(unitGrams) : undefined;
    if ((cupValue !== undefined && !(cupValue > 0)) || (unitValue !== undefined && !(unitValue > 0))) return inform('Os pesos de equivalência devem ser maiores que zero (ou deixe em branco).');
    const values = {
      name: name.trim(), unit, purchaseQuantity: quantity, purchasePrice: p,
      ...(cupValue ? { densityGPerMl: gramsPerCupToDensity(cupValue, cup) } : {}),
      ...(unitValue ? { gramsPerUnit: unitValue } : {}),
    };
    if (editingId) {
      const unitWarning = unitChangeAffectsRecipes(data, editingId, unit);
      update(d => updateIngredient(d, editingId, values));
      resetForm();
      inform(unitWarning ? 'Ingrediente atualizado. Atenção: você mudou a unidade; revise as quantidades nas receitas antigas que o usam.' : 'Ingrediente atualizado. Os custos das receitas foram recalculados.');
      return;
    }
    update(d => ({ ...d, ingredients: [...d.ingredients, { id: newId(), ...values }] }));
    resetForm(); inform('Ingrediente cadastrado.');
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
          <p className="form-subtitle">Exemplo: 1000 g de farinha por R$ 6,90.</p>
          <div className="stack" style={{ gap: 12, borderTop: '1px solid #edf0f3', paddingTop: 14 }}>
            <strong style={{ fontSize: 13 }}>Equivalências para as receitas (opcional)</strong>
            <Field label={`1 xícara (${cup} mL) pesa quantos gramas?`}><input type="number" min="0.1" step="any" value={cupGrams} onChange={e => setCupGrams(e.target.value)} placeholder="Ex.: 120" /></Field>
            {reference && refDensity && !cupGrams && <div className="notice">Referência aproximada: 1 xícara de {reference.name.toLowerCase()} ≈ {Number((refDensity * 240).toFixed(1))} g (xícara de 240 mL). <button type="button" className="secondary" style={{ marginTop: 8, minHeight: 36 }} onClick={() => setCupGrams(String(Number((refDensity * cup).toFixed(2))))}>Usar esta referência</button></div>}
            <Field label="1 unidade pesa quantos gramas?"><input type="number" min="0.1" step="any" value={unitGrams} onChange={e => setUnitGrams(e.target.value)} placeholder="Ex.: 50 (um ovo)" /></Field>
            {reference?.gramsPerUnit && !unitGrams && <div className="notice">Referência aproximada: 1 unidade de {reference.name.toLowerCase()} ≈ {reference.gramsPerUnit} g. <button type="button" className="secondary" style={{ marginTop: 8, minHeight: 36 }} onClick={() => setUnitGrams(String(reference.gramsPerUnit))}>Usar esta referência</button></div>}
            <p className="form-subtitle" style={{ margin: 0 }}>Permite usar xícaras, colheres e unidades nas receitas. {REFERENCE_DISCLAIMER} Você pode ajustar o valor.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Adicionar ingrediente</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="card"><h2 className="section-title">Ingredientes cadastrados ({data.ingredients.length})</h2>
        {data.ingredients.length ? <div className="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Compra</th><th>Preço</th><th></th></tr></thead><tbody>{data.ingredients.map(i => <tr key={i.id}><td>{i.name}</td><td>{i.purchaseQuantity} {i.unit}{i.densityGPerMl ? <div className="muted" style={{ fontSize: 12 }}>1 xícara ≈ {formatQuantity(densityToGramsPerCup(i.densityGPerMl, cup), 'g')} g</div> : null}{i.gramsPerUnit ? <div className="muted" style={{ fontSize: 12 }}>1 un. ≈ {formatQuantity(i.gramsPerUnit, 'g')} g</div> : null}</td><td>{money(i.purchasePrice)}</td><td style={{ whiteSpace: 'nowrap' }}><button aria-label={`Editar ${i.name}`} title="Editar" className="inline-icon" onClick={() => startEdit(i.id)}><Pencil size={15} /></button><button aria-label={`Excluir ${i.name}`} title="Excluir" className="inline-icon" onClick={() => removeIngredient(i.id)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty"><ShoppingBasket size={30} />Sua lista de ingredientes aparecerá aqui.</div>}
      </section>
    </div>
    <p className="footnote">Na receita você pode usar g, kg, mL, L, xícara, colheres e unidades; o app converte para a unidade de compra. Se faltar uma equivalência, o app avisa qual e não calcula o custo daquele ingrediente.</p>
  </>;
}
