import { useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, ClipboardPaste, Pencil, Plus, Ruler, Save, Trash2, X } from 'lucide-react';
import { applyEquivalences, updateRecipe } from '../domain/edit';
import { effectiveEquivalence } from '../domain/equivalence';
import { money, moneyPrecise, recipeCost } from '../domain/pricing';
import type { MeasureUnit, Recipe, RecipeItem, RecipePackagingItem } from '../domain/types';
import { Field } from '../components/Field';
import { MoneyInput } from '../components/MoneyInput';
import { parseMoneyInput } from '../domain/money';
import { convert, conversionErrorMessage } from '../features/measurement/convert';
import { RecipeTextImporter, type ImportConfirm } from '../features/recipe-import/components/RecipeTextImporter';
import { MeasurementConverter, type ConverterUse } from '../features/measurement/components/MeasurementConverter';
import { formatQuantity, friendlyAmount, UNIT_ORDER, UNITS, unitText } from '../features/measurement/units';
import { isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { parseQuantity } from '../domain/quantity';
import { cupSizeOf, newId, parse, priceRecipe, tryApply, withSettings, type PageProps } from '../utils';

type RecipeItemDraft = RecipeItem & { quantityInput: string };
type RecipePackagingDraft = RecipePackagingItem & { quantityInput: string };

export function RecipesPage({ data, update, inform }: PageProps) {
  const [name, setName] = useState('');
  const [yieldQty, setYieldQty] = useState('10');
  const [items, setItems] = useState<RecipeItemDraft[]>([]);
  const [packaging, setPackaging] = useState('');
  const [labor, setLabor] = useState('');
  const [extras, setExtras] = useState('');
  const [packagingItems, setPackagingItems] = useState<RecipePackagingDraft[]>([]);
  const [margin, setMargin] = useState('30');
  const [prep, setPrep] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showConverter, setShowConverter] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const cupSizeMl = cupSizeOf(data);

  function resetForm() {
    setEditingId(null); setName(''); setYieldQty('10'); setItems([]); setPackaging(''); setPackagingItems([]); setLabor(''); setExtras(''); setMargin('30'); setPrep('');
  }
  function startEdit(id: string) {
    const r = data.recipes.find(x => x.id === id);
    if (!r) return;
    setEditingId(r.id); setName(r.name); setYieldQty(String(r.yield)); setItems(r.items.map(i => ({ ...i, quantityInput: String(i.quantity), unit: i.unit ?? data.ingredients.find(x => x.id === i.ingredientId)?.unit })));
    setPackaging(String(r.packagingPerUnit)); setPackagingItems((r.packagingItems ?? []).map(i => ({ ...i, quantityInput: String(i.quantityPerUnit) }))); setLabor(String(r.laborTotal)); setExtras(String(r.extraTotal)); setMargin(String(r.desiredMargin)); setPrep(r.prepMinutes ? String(r.prepMinutes) : '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveRecipe(e: FormEvent) {
    e.preventDefault();
    const amount = (v: string) => { const parsed = parseMoneyInput(v); return parsed === undefined ? 0 : toCents2(parsed); };
    const yieldNum = parse(yieldQty), pack = amount(packaging), lab = amount(labor), extra = amount(extras), m = parse(margin);
    const itemQuantities = items.map(i => parseQuantity(i.quantityInput));
    const packagingQuantities = packagingItems.map(i => parseQuantity(i.quantityInput));
    if (!name.trim() || !isPositiveQuantity(yieldNum) || !items.length || items.some((i, index) => !isPositiveQuantity(itemQuantities[index] ?? 0) || !data.ingredients.some(x => x.id === i.ingredientId)) || packagingItems.some((i, index) => !isPositiveQuantity(packagingQuantities[index] ?? 0) || !data.packagings.some(x => x.id === i.packagingId)) || ![pack, lab, extra].every(isMoney) || !Number.isFinite(m) || m < 0 || m >= 100) return inform('Revise rendimento, ingredientes e custos. Margem: 0 até menos de 100%.');
    const prepNum = prep.trim() ? parse(prep) : undefined;
    if (prepNum !== undefined && !(prepNum > 0 && prepNum <= 10080)) return inform('O tempo de produção deve ser maior que zero (em minutos) ou ficar em branco.');
    const savedItems: RecipeItem[] = items.map((item, index) => { const { quantityInput: _draft, ...saved } = item; return { ...saved, quantity: itemQuantities[index]! }; });
    const savedPackagingItems: RecipePackagingItem[] = packagingItems.map((item, index) => { const { quantityInput: _draft, ...saved } = item; return { ...saved, quantityPerUnit: packagingQuantities[index]! }; });
    const values = { name: name.trim(), yield: yieldNum, items: savedItems, packagingItems: savedPackagingItems, packagingPerUnit: pack, laborTotal: lab, extraTotal: extra, desiredMargin: m, ...(prepNum !== undefined ? { prepMinutes: prepNum } : {}) };
    try { recipeCost({ id: editingId ?? 'novo', ...values }, data.ingredients, cupSizeMl, data.packagings); } catch (err) { return inform(err instanceof Error ? err.message : 'Não foi possível calcular o custo desta receita.'); }
    if (editingId) {
      const failed = tryApply(data, update, d => updateRecipe(d, editingId, values));
      if (failed) return inform(failed);
      setSelectedId(editingId); resetForm(); inform('Receita atualizada. Encomendas já registradas não foram alteradas.');
      return;
    }
    const recipe: Recipe = { id: newId(), ...values };
    update(d => ({ ...d, recipes: [...d.recipes, recipe] }));
    setSelectedId(recipe.id); setName(''); setItems([]); setPackagingItems([]); inform('Receita cadastrada.');
  }
  function useConversion(use: ConverterUse) {
    const existingIndex = items.findIndex(x => x.ingredientId === use.ingredientId);
    if (existingIndex >= 0) {
      setItems(list => list.map((x, i) => i === existingIndex ? { ...x, quantity: use.quantity, quantityInput: String(use.quantity), unit: use.unit } : x));
    } else {
      setItems(list => [...list, { ingredientId: use.ingredientId, quantity: use.quantity, quantityInput: String(use.quantity), unit: use.unit }]);
    }
    inform('Medida aplicada à receita (se o ingrediente já estava na lista, a linha foi atualizada).');
  }
  function importIngredients({ items: incoming, patches }: ImportConfirm) {
    if (patches.length) { const failed = tryApply(data, update, d => applyEquivalences(d, patches)); if (failed) return inform(failed); }
    // evita duplicar uma linha idêntica (mesmo ingrediente, quantidade e medida) já presente na receita
    const added = incoming.filter(n => !items.some(x => x.ingredientId === n.ingredientId && parseQuantity(x.quantityInput) === n.quantity && x.unit === n.unit));
    setItems(list => [...list, ...added.map(item => ({ ...item, quantityInput: String(item.quantity) }))]);
    setShowImport(false);
    inform(`${incoming.length} ingrediente(s) adicionado(s) à receita. Revise e clique em "Salvar receita" para guardar.`);
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
    {showImport && <section className="card" style={{ marginBottom: 19 }}><RecipeTextImporter ingredients={data.ingredients} cupSizeMl={cupSizeMl} onConfirm={importIngredients} onCancel={() => setShowImport(false)} /></section>}
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
                const patch = (change: Partial<RecipeItemDraft>) => setItems(list => list.map((x, i) => i === index ? { ...x, ...change } : x));
                const currentQuantity = parseQuantity(item.quantityInput);
              let hint = '';
                if (ing && unit !== ing.unit && currentQuantity && currentQuantity > 0) {
                const r = convert({ quantity: currentQuantity, from: unit, to: ing.unit, ...(({ densityGPerMl, gramsPerUnit }) => ({ densityGPerMl, gramsPerUnit }))(effectiveEquivalence(ing)), cupSizeMl });
                hint = r.success ? (() => { const f = friendlyAmount(r.value, ing.unit); return `${r.approximate ? '≈' : '='} ${formatQuantity(f.value, f.unit)} ${unitText(f.unit, f.value)} (usado no cálculo do custo)`; })() : conversionErrorMessage(r.error, unit, ing.unit, ing.name);
              }
              return <div key={index} style={{ marginBottom: 10 }}>
                <div className="recipe-line">
                  <select aria-label="Ingrediente" value={item.ingredientId} onChange={e => { const next = data.ingredients.find(x => x.id === e.target.value); patch({ ingredientId: e.target.value, unit: next?.unit }); }}>{data.ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
                  <input aria-label="Quantidade utilizada" type="text" inputMode="decimal" value={item.quantityInput} aria-invalid={item.quantityInput.trim() !== '' && !(currentQuantity && currentQuantity > 0)} onChange={e => { const quantityInput = e.target.value; const quantity = parseQuantity(quantityInput); patch({ quantityInput, ...(quantity !== undefined ? { quantity } : {}) }); }} />
                  <select aria-label="Medida" value={unit} onChange={e => patch({ unit: e.target.value as MeasureUnit })}>{UNIT_ORDER.map(u => <option key={u} value={u}>{UNITS[u].long}</option>)}</select>
                  <button aria-label="Remover ingrediente da receita" type="button" className="inline-icon" onClick={() => setItems(list => list.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
                </div>
                {hint && <p className="form-subtitle" style={{ margin: '4px 0 0' }}>{hint}</p>}
              </div>;
            })}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary" disabled={!data.ingredients.length} onClick={() => setItems(list => [...list, { ingredientId: data.ingredients[0].id, quantity: 100, quantityInput: '100', unit: data.ingredients[0].unit }])}><Plus size={16} /> Adicionar ingrediente</button>
            <button type="button" className="secondary" disabled={!data.ingredients.length} onClick={() => setShowImport(v => !v)}><ClipboardPaste size={16} /> Colar lista</button>
            <button type="button" className="secondary" onClick={() => setShowConverter(v => !v)}><Ruler size={16} /> {showConverter ? 'Fechar conversor' : 'Conversor de medidas'}</button>
            </div>
            {showConverter && <div className="card" style={{ marginTop: 12, background: 'var(--color-surface-muted)' }}><MeasurementConverter ingredients={data.ingredients} cupSizeMl={cupSizeMl} onCupSizeChange={n => update(d => withSettings(d, { cupSizeMl: n }))} onUse={useConversion} /></div>}
          </div>
          <section aria-labelledby="recipe-packagings-heading" className="stack">
            <div><h3 id="recipe-packagings-heading" style={{ marginBottom: 4 }}>Embalagens por unidade</h3><p className="form-subtitle">Custos calculados automaticamente e congelados nas novas encomendas.</p></div>
            {(packagingItems ?? []).map((item, index) => <div className="recipe-line" key={item.packagingId}>
                <select aria-label="Embalagem da receita" value={item.packagingId} onChange={e => setPackagingItems(list => list.map((x, i) => i === index ? { ...x, packagingId: e.target.value } : x))}>
                {(data.packagings ?? []).filter(p => p.active || p.id === item.packagingId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input aria-label="Quantidade de embalagens por unidade" type="text" inputMode="decimal" value={item.quantityInput} aria-invalid={item.quantityInput.trim() !== '' && !(parseQuantity(item.quantityInput)! > 0)} onChange={e => { const quantityInput = e.target.value; const quantity = parseQuantity(quantityInput); setPackagingItems(list => list.map((x, i) => i === index ? { ...x, quantityInput, ...(quantity !== undefined ? { quantityPerUnit: quantity } : {}) } : x)); }} />
              <span className="muted">un./produto</span>
              <button type="button" aria-label="Remover embalagem da receita" className="inline-icon" onClick={() => setPackagingItems(list => list.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
            </div>)}
            <button className="secondary" type="button" disabled={!(data.packagings ?? []).some(p => p.active && !packagingItems.some(x => x.packagingId === p.id))} onClick={() => { const next = data.packagings.find(p => p.active && !packagingItems.some(x => x.packagingId === p.id)); if (next) setPackagingItems(list => [...list, { packagingId: next.id, quantityPerUnit: 1, quantityInput: '1' }]); }}><Plus size={16} /> Adicionar embalagem</button>
            {packagingItems.length > 0 && <p className="muted">Custo automático: {moneyPrecise(packagingItems.reduce((total, item) => { const p = data.packagings.find(x => x.id === item.packagingId); const quantity = parseQuantity(item.quantityInput); return total + (p && quantity && quantity > 0 ? p.purchasePrice / p.purchaseQuantity * quantity : 0); }, 0))} por unidade.</p>}
          </section>
          <div className="form-grid">
            <Field label="Embalagem manual por unidade (R$)"><MoneyInput value={packaging} onValueChange={setPackaging} /></Field>
            <Field label="Mão de obra por receita (R$)"><MoneyInput value={labor} onValueChange={setLabor} /></Field>
            <Field label="Outros custos por receita (R$)"><MoneyInput value={extras} onValueChange={setExtras} /></Field>
            <Field label="Margem desejada (%)"><input type="number" min="0" max="99.99" step="any" value={margin} onChange={e => setMargin(e.target.value)} /></Field>
            <Field label="Tempo de produção, em minutos (opcional)"><input type="number" min="1" max="10080" step="any" value={prep} onChange={e => setPrep(e.target.value)} placeholder="Ex.: 120" /></Field>
          </div>
          <p className="form-subtitle">Embalagem manual, mão de obra e outros custos são opcionais: deixe em branco quando não houver custo (equivale a R$ 0,00).</p>
          <div style={{ display: 'flex', gap: 8 }}><button type="submit" className="primary" disabled={!data.ingredients.length}><Save size={17} /> {editingId ? 'Salvar alterações' : 'Salvar receita'}</button>{editingId && <button type="button" className="secondary" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="stack">
        <div className="card"><h2 className="section-title">Simulador de preço</h2><p className="muted">Selecione uma receita cadastrada.</p>
          <div style={{ margin: '16px 0' }}><select value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">Selecione uma receita...</option>{data.recipes.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select></div>
          {selected && priced && !priced.ok ? <div className="notice warn"><strong>Custo indisponível.</strong> {priced.message}</div> : null}
          {selected && selectedCost ? <div className="formula">
            {selectedCost.lines.map(l => <div key={l.ingredientId} className="formula-row" style={{ fontSize: 13 }}><span>{formatQuantity(l.quantity, l.unit)} {unitText(l.unit, l.quantity)} de {l.name}{l.unit !== l.convertedUnit ? <span className="muted"> {l.approximate ? '≈' : '='} {(() => { const f = friendlyAmount(l.convertedQuantity, l.convertedUnit); return `${formatQuantity(f.value, f.unit)} ${unitText(f.unit, f.value)}`; })()}</span> : null}</span><strong>{money(l.cost)}</strong></div>)}
            <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', width: '100%' }} />
            <div className="formula-row"><span>Ingredientes</span><strong>{money(selectedCost.materials)}</strong></div>
            <div className="formula-row"><span>Embalagens</span><strong>{money(selectedCost.packaging)}</strong></div>
            <div className="formula-row"><span>Mão de obra</span><strong>{money(selectedCost.labor)}</strong></div>
            <div className="formula-row"><span>Outros custos</span><strong>{money(selectedCost.extras)}</strong></div>
            <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', width: '100%' }} />
            <div className="formula-row"><span>Custo por unidade</span><strong>{money(selectedCost.costPerUnit)}</strong></div>
            <div className="formula-row" style={{ alignItems: 'center' }}><strong>Preço sugerido</strong><strong style={{ fontSize: 24, color: 'var(--color-success)' }}>{money(selectedCost.suggestedPrice)}</strong></div>
            <span className="footnote" style={{ margin: 0 }}>Margem sobre preço de venda: {selected.desiredMargin}%.</span>
          </div> : !priced ? <div className="empty"><BookOpen size={30} />Cadastre uma receita para visualizar os cálculos.</div> : null}
        </div>
        <div className="card"><h2 className="section-title">Minhas receitas ({data.recipes.length})</h2>
          {data.recipes.length ? <div className="stack">{data.recipes.map(r => <div key={r.id} style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 9, alignItems: 'center' }}>
            <div><strong style={{ fontSize: 13 }}>{r.name}</strong><div className="muted">{r.yield} unidade(s) · {(() => { const pr = priceRecipe(r, data); return pr.ok ? `${money(pr.cost.suggestedPrice)} sugerido` : <span style={{ color: 'var(--color-warning)' }} title={pr.message}>custo indisponível: falta uma equivalência</span>; })()}</div></div>
            <div style={{ display: 'flex', gap: 5 }}><button className="secondary" onClick={() => setSelectedId(r.id)} aria-label={`Analisar ${r.name}`}><ArrowRight size={14} /></button><button className="inline-icon" onClick={() => startEdit(r.id)} aria-label={`Editar ${r.name}`} title="Editar"><Pencil size={14} /></button><button className="inline-icon" onClick={() => removeRecipe(r.id)} aria-label={`Excluir ${r.name}`}><Trash2 size={14} /></button></div>
          </div>)}</div> : <div className="empty">Ainda não há receitas.</div>}
        </div>
      </section>
    </div>
    <p className="footnote">Margem significa (preço − custo) ÷ preço; não equivale a markup. Revise despesas fixas, impostos, perdas e demais custos antes de usar um preço comercial.</p>
  </>;
}
