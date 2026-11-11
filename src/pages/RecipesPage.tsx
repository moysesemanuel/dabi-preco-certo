import { useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Pencil, Plus, Ruler, Save, Trash2, X } from 'lucide-react';
import { updateRecipe } from '../domain/edit';
import { money, recipeCost } from '../domain/pricing';
import type { MeasureUnit, Recipe, RecipeItem } from '../domain/types';
import { Field } from '../components/Field';
import { convert, conversionErrorMessage } from '../features/measurement/convert';
import { MeasurementConverter, type ConverterUse } from '../features/measurement/components/MeasurementConverter';
import { formatQuantity, friendlyAmount, UNIT_ORDER, UNITS, unitText } from '../features/measurement/units';
import { cupSizeOf, newId, parse, priceRecipe, type PageProps } from '../utils';

export function RecipesPage({ data, update, inform }: PageProps) {
  const [name, setName] = useState('');
  const [yieldQty, setYieldQty] = useState('10');
  const [items, setItems] = useState<RecipeItem[]>([]);
  const [packaging, setPackaging] = useState('0');
  const [labor, setLabor] = useState('0');
  const [extras, setExtras] = useState('0');
  const [margin, setMargin] = useState('30');
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showConverter, setShowConverter] = useState(false);
  const cupSizeMl = cupSizeOf(data);

  function resetForm() {
    setEditingId(null); setName(''); setYieldQty('10'); setItems([]); setPackaging('0'); setLabor('0'); setExtras('0'); setMargin('30');
  }
  function startEdit(id: string) {
    const r = data.recipes.find(x => x.id === id);
    if (!r) return;
    setEditingId(r.id); setName(r.name); setYieldQty(String(r.yield)); setItems(r.items.map(i => ({ ...i, unit: i.unit ?? data.ingredients.find(x => x.id === i.ingredientId)?.unit })));
    setPackaging(String(r.packagingPerUnit)); setLabor(String(r.laborTotal)); setExtras(String(r.extraTotal)); setMargin(String(r.desiredMargin));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveRecipe(e: FormEvent) {
    e.preventDefault();
    const yieldNum = parse(yieldQty), pack = parse(packaging), lab = parse(labor), extra = parse(extras), m = parse(margin);
    if (!name.trim() || !(yieldNum > 0) || !items.length || items.some(i => !(i.quantity > 0) || !data.ingredients.some(x => x.id === i.ingredientId)) || ![pack, lab, extra, m].every(Number.isFinite) || [pack, lab, extra, m].some(x => x < 0) || m >= 100) return inform('Revise rendimento, ingredientes e custos. Margem: 0 até menos de 100%.');
    const values = { name: name.trim(), yield: yieldNum, items, packagingPerUnit: pack, laborTotal: lab, extraTotal: extra, desiredMargin: m };
    try { recipeCost({ id: editingId ?? 'novo', ...values }, data.ingredients, cupSizeMl); } catch (err) { return inform(err instanceof Error ? err.message : 'Não foi possível calcular o custo desta receita.'); }
    if (editingId) {
      update(d => updateRecipe(d, editingId, values));
      setSelectedId(editingId); resetForm(); inform('Receita atualizada. Encomendas já registradas não foram alteradas.');
      return;
    }
    const recipe: Recipe = { id: newId(), ...values };
    update(d => ({ ...d, recipes: [...d.recipes, recipe] }));
    setSelectedId(recipe.id); setName(''); setItems([]); inform('Receita cadastrada.');
  }
  function useConversion(use: ConverterUse) {
    setItems(list => list.some(x => x.ingredientId === use.ingredientId)
      ? list.map(x => (x.ingredientId === use.ingredientId ? { ...x, quantity: use.quantity, unit: use.unit } : x))
      : [...list, { ingredientId: use.ingredientId, quantity: use.quantity, unit: use.unit }]);
    inform('Medida aplicada à receita (se o ingrediente já estava na lista, a linha foi atualizada).');
  }
  function removeRecipe(recipeId: string) {
    if (data.orders.some(o => o.recipeId === recipeId)) return inform('Esta receita possui encomendas. Exclua as encomendas antes.');
    if (!confirm('Excluir esta receita?')) return;
    update(d => ({ ...d, recipes: d.recipes.filter(r => r.id !== recipeId) }));
    if (selectedId === recipeId) setSelectedId('');
    if (editingId === recipeId) resetForm();
  }

  const selected = data.recipes.find(r => r.id === selectedId);
  const priced = selected ? priceRecipe(selected, data) : null;
  const selectedCost = priced?.ok ? priced.cost : null;

  return <>
    <div className="head"><div><div className="eyebrow">Custo e preço sugerido</div><h1>Receitas e precificação</h1><p className="muted">Organize ingredientes, rendimento, embalagem e mão de obra.</p></div></div>
    <div className="two">
      <section className="card"><h2 className="section-title">{editingId ? 'Editar receita' : 'Criar receita'}</h2>
        <form className="stack" onSubmit={saveRecipe} style={{ marginTop: 19 }}>
          <div className="form-grid">
            <Field label="Nome da receita"><input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Bolo de cenoura" required /></Field>
            <Field label="Rendimento (unidades)"><input type="number" min="0.01" step="any" value={yieldQty} onChange={e => setYieldQty(e.target.value)} required /></Field>
          </div>
          <div><label>Ingredientes utilizados</label><p className="form-subtitle" style={{ marginBottom: 12 }}>Informe a medida como está na receita (g, xícara, colher...). O app guarda essa medida e converte para a unidade de compra só no cálculo.</p>
            {items.map((item, index) => {
              const ing = data.ingredients.find(x => x.id === item.ingredientId);
              const unit: MeasureUnit = item.unit ?? ing?.unit ?? 'g';
              const patch = (change: Partial<RecipeItem>) => setItems(list => list.map((x, i) => i === index ? { ...x, ...change } : x));
              let hint = '';
              if (ing && unit !== ing.unit && item.quantity > 0) {
                const r = convert({ quantity: item.quantity, from: unit, to: ing.unit, densityGPerMl: ing.densityGPerMl, gramsPerUnit: ing.gramsPerUnit, cupSizeMl });
                hint = r.success ? (() => { const f = friendlyAmount(r.value, ing.unit); return `${r.approximate ? '≈' : '='} ${formatQuantity(f.value, f.unit)} ${unitText(f.unit, f.value)} (usado no cálculo do custo)`; })() : conversionErrorMessage(r.error, unit, ing.unit, ing.name);
              }
              return <div key={index} style={{ marginBottom: 10 }}>
                <div className="recipe-line">
                  <select aria-label="Ingrediente" value={item.ingredientId} onChange={e => { const next = data.ingredients.find(x => x.id === e.target.value); patch({ ingredientId: e.target.value, unit: next?.unit }); }}>{data.ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
                  <input aria-label="Quantidade utilizada" type="number" min="0.001" step="any" value={item.quantity} onChange={e => patch({ quantity: parse(e.target.value) })} />
                  <select aria-label="Medida" value={unit} onChange={e => patch({ unit: e.target.value as MeasureUnit })}>{UNIT_ORDER.map(u => <option key={u} value={u}>{UNITS[u].long}</option>)}</select>
                  <button aria-label="Remover ingrediente da receita" type="button" className="inline-icon" onClick={() => setItems(list => list.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
                </div>
                {hint && <p className="form-subtitle" style={{ margin: '4px 0 0' }}>{hint}</p>}
              </div>;
            })}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary" disabled={!data.ingredients.length} onClick={() => setItems(list => [...list, { ingredientId: data.ingredients[0].id, quantity: 100, unit: data.ingredients[0].unit }])}><Plus size={16} /> Adicionar ingrediente</button>
            <button type="button" className="secondary" onClick={() => setShowConverter(v => !v)}><Ruler size={16} /> {showConverter ? 'Fechar conversor' : 'Conversor de medidas'}</button>
            </div>
            {showConverter && <div className="card" style={{ marginTop: 12, background: '#fbfaf7' }}><MeasurementConverter ingredients={data.ingredients} cupSizeMl={cupSizeMl} onCupSizeChange={n => update(d => ({ ...d, settings: { cupSizeMl: n } }))} onUse={useConversion} /></div>}
          </div>
          <div className="form-grid">
            <Field label="Embalagem por unidade (R$)"><input type="number" min="0" step="0.01" value={packaging} onChange={e => setPackaging(e.target.value)} /></Field>
            <Field label="Mão de obra por receita (R$)"><input type="number" min="0" step="0.01" value={labor} onChange={e => setLabor(e.target.value)} /></Field>
            <Field label="Outros custos por receita (R$)"><input type="number" min="0" step="0.01" value={extras} onChange={e => setExtras(e.target.value)} /></Field>
            <Field label="Margem desejada (%)"><input type="number" min="0" max="99.99" step="any" value={margin} onChange={e => setMargin(e.target.value)} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button type="submit" className="primary" disabled={!data.ingredients.length}><Save size={17} /> {editingId ? 'Salvar alterações' : 'Salvar receita'}</button>{editingId && <button type="button" className="secondary" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="stack">
        <div className="card"><h2 className="section-title">Simulador de preço</h2><p className="muted">Selecione uma receita cadastrada.</p>
          <div style={{ margin: '16px 0' }}><select value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">Selecione uma receita...</option>{data.recipes.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select></div>
          {selected && priced && !priced.ok ? <div className="notice warn"><strong>Custo indisponível.</strong> {priced.message}</div> : null}
          {selected && selectedCost ? <div className="formula">
            {selectedCost.lines.map(l => <div key={l.ingredientId} className="formula-row" style={{ fontSize: 13 }}><span>{formatQuantity(l.quantity, l.unit)} {unitText(l.unit, l.quantity)} de {l.name}{l.unit !== l.convertedUnit ? <span className="muted"> {l.approximate ? '≈' : '='} {(() => { const f = friendlyAmount(l.convertedQuantity, l.convertedUnit); return `${formatQuantity(f.value, f.unit)} ${unitText(f.unit, f.value)}`; })()}</span> : null}</span><strong>{money(l.cost)}</strong></div>)}
            <hr style={{ border: 'none', borderTop: '1px solid #dce4eb', width: '100%' }} />
            <div className="formula-row"><span>Ingredientes</span><strong>{money(selectedCost.materials)}</strong></div>
            <div className="formula-row"><span>Embalagens</span><strong>{money(selectedCost.packaging)}</strong></div>
            <div className="formula-row"><span>Mão de obra</span><strong>{money(selectedCost.labor)}</strong></div>
            <div className="formula-row"><span>Outros custos</span><strong>{money(selectedCost.extras)}</strong></div>
            <hr style={{ border: 'none', borderTop: '1px solid #dce4eb', width: '100%' }} />
            <div className="formula-row"><span>Custo por unidade</span><strong>{money(selectedCost.costPerUnit)}</strong></div>
            <div className="formula-row" style={{ alignItems: 'center' }}><strong>Preço sugerido</strong><strong style={{ fontSize: 24, color: '#16794a' }}>{money(selectedCost.suggestedPrice)}</strong></div>
            <span className="footnote" style={{ margin: 0 }}>Margem sobre preço de venda: {selected.desiredMargin}%.</span>
          </div> : !priced ? <div className="empty"><BookOpen size={30} />Cadastre uma receita para visualizar os cálculos.</div> : null}
        </div>
        <div className="card"><h2 className="section-title">Minhas receitas ({data.recipes.length})</h2>
          {data.recipes.length ? <div className="stack">{data.recipes.map(r => <div key={r.id} style={{ borderBottom: '1px solid #edf0f3', paddingBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 9, alignItems: 'center' }}>
            <div><strong style={{ fontSize: 13 }}>{r.name}</strong><div className="muted">{r.yield} unidade(s) · {(() => { const pr = priceRecipe(r, data); return pr.ok ? `${money(pr.cost.suggestedPrice)} sugerido` : <span style={{ color: '#9a5a0d' }} title={pr.message}>custo indisponível: falta uma equivalência</span>; })()}</div></div>
            <div style={{ display: 'flex', gap: 5 }}><button className="secondary" onClick={() => setSelectedId(r.id)} aria-label={`Analisar ${r.name}`}><ArrowRight size={14} /></button><button className="inline-icon" onClick={() => startEdit(r.id)} aria-label={`Editar ${r.name}`} title="Editar"><Pencil size={14} /></button><button className="inline-icon" onClick={() => removeRecipe(r.id)} aria-label={`Excluir ${r.name}`}><Trash2 size={14} /></button></div>
          </div>)}</div> : <div className="empty">Ainda não há receitas.</div>}
        </div>
      </section>
    </div>
    <p className="footnote">Margem significa (preço − custo) ÷ preço; não equivale a markup. Revise despesas fixas, impostos, perdas e demais custos antes de usar um preço comercial.</p>
  </>;
}
