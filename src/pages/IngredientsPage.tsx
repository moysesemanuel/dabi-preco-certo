import { useMemo, useState, type FormEvent } from 'react';
import { Pencil, Plus, Save, ShoppingBasket, Trash2, X } from 'lucide-react';
import { unitChangeAffectsRecipes, updateIngredient } from '../domain/edit';
import { costImpact } from '../domain/impact';
import { money } from '../domain/pricing';
import { parseQuantity } from '../domain/quantity';
import type { CatalogRef, DataSet, Ingredient, Unit } from '../domain/types';
import { Field } from '../components/Field';
import { CATALOG_VERSION, makeRef, refDiffersFromCatalog, searchCatalog } from '../features/measurement/catalog';
import { MeasuresDialog, type MeasuresDraft } from '../features/measurement/components/MeasuresDialog';
import { MeasuresSummary, measureLines } from '../features/measurement/components/MeasuresSummary';
import { densityToGramsPerCup, gramsPerCupToDensity } from '../features/measurement/densities';
import { isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { cupSizeOf, newId, parse, tryApply, units, type PageProps } from '../utils';

const brl = (n?: number) => (n === undefined ? 'não calculável' : money(n));
/** Frase curta com as receitas cujo custo mudou. */
function impactText(changes: ReturnType<typeof costImpact>): string {
  const shown = changes.slice(0, 3).map(c => `${c.name} (${brl(c.before)} → ${brl(c.after)})`).join('; ');
  return `${changes.length} ${changes.length === 1 ? 'receita mudou' : 'receitas mudaram'} de custo por unidade: ${shown}${changes.length > 3 ? '…' : ''}.`;
}
export function IngredientsPage({ data, update, inform }: PageProps) {
  const cup = cupSizeOf(data);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [qty, setQty] = useState('1000');
  const [price, setPrice] = useState('');
  const [cupGrams, setCupGrams] = useState('');
  const [unitGrams, setUnitGrams] = useState('');
  const [catalogRef, setCatalogRef] = useState<CatalogRef | undefined>();
  const [declined, setDeclined] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  // Ingrediente NOVO com nome conhecido: a referência encontrada já aparece no resumo e é gravada junto (a pessoa pode ajustar ou remover).
  // Ao EDITAR, nada é adotado sozinho: só o que a pessoa escolher em "Ajustar".
  const found = useMemo(() => (editingId || catalogRef || declined ? undefined : searchCatalog(name).exact), [name, editingId, catalogRef, declined]);
  const effRef = catalogRef ?? (found ? makeRef(found.id) : undefined);

  function resetForm() { setEditingId(null); setName(''); setUnit('g'); setQty('1000'); setPrice(''); setCupGrams(''); setUnitGrams(''); setCatalogRef(undefined); setDeclined(false); setAdjusting(false); }
  function startEdit(id: string) {
    const i = data.ingredients.find(x => x.id === id);
    if (!i) return;
    setEditingId(i.id); setName(i.name); setUnit(i.unit); setQty(String(i.purchaseQuantity)); setPrice(String(i.purchasePrice));
    setCupGrams(i.densityGPerMl ? String(Number(densityToGramsPerCup(i.densityGPerMl, cup).toFixed(2))) : '');
    setUnitGrams(i.gramsPerUnit ? String(i.gramsPerUnit) : '');
    setCatalogRef(i.catalogRef); setDeclined(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function updateAvailable(i: Ingredient) { return !!i.catalogRef && i.catalogRef.version !== CATALOG_VERSION && refDiffersFromCatalog(i.catalogRef); }
  function updateReference(i: Ingredient) {
    const fresh = makeRef(i.catalogRef!.id, i.catalogRef!.variant); if (!fresh) return;
    const { id: _id, ...rest } = i;
    const after: DataSet = updateIngredient(data, i.id, { ...rest, catalogRef: fresh });
    const changes = costImpact(data, after);
    if (!confirm(`Atualizar a referência de medidas de “${i.name}” para a versão ${CATALOG_VERSION} do catálogo?${changes.length ? `\n\nIsto muda o custo: ${impactText(changes)}` : '\n\nNenhuma receita muda de custo.'}\n\nEncomendas e custos já registrados não são alterados.`)) return;
    update(() => after); setCatalogRef(fresh); setAdjusting(false); inform(changes.length ? `Referência atualizada. ${impactText(changes)}` : 'Referência atualizada. Nenhum custo mudou.');
  }
  function saveIngredient(e: FormEvent) {
    e.preventDefault();
    const quantity = parse(qty), p = toCents2(parse(price));
    if (!name.trim() || !isPositiveQuantity(quantity) || !isMoney(p)) return inform('Preencha nome, quantidade positiva e preço válido.');
    const cupValue = cupGrams.trim() ? parseQuantity(cupGrams) : undefined;
    const unitValue = unitGrams.trim() ? parseQuantity(unitGrams) : undefined;
    if ((cupGrams.trim() && !(cupValue! > 0)) || (unitGrams.trim() && !(unitValue! > 0))) return inform('Os pesos de equivalência devem ser números maiores que zero (ou deixe em branco).');
    const values = {
      name: name.trim(), unit, purchaseQuantity: quantity, purchasePrice: p,
      ...(cupValue ? { densityGPerMl: gramsPerCupToDensity(cupValue, cup) } : {}),
      ...(unitValue ? { gramsPerUnit: unitValue } : {}),
      ...(effRef ? { catalogRef: effRef } : {}),
    };
    if (editingId) {
      const unitWarning = unitChangeAffectsRecipes(data, editingId, unit);
      const original = data.ingredients.find(i => i.id === editingId);
      const eqBefore = original ? JSON.stringify([original.densityGPerMl, original.gramsPerUnit, original.catalogRef]) : '';
      const measuresChanged = eqBefore !== JSON.stringify([values.densityGPerMl, values.gramsPerUnit, values.catalogRef]);
      let changes: ReturnType<typeof costImpact> = [];
      const failed = tryApply(data, update, d => { const next = updateIngredient(d, editingId, values); changes = costImpact(d, next); return next; });
      if (failed) return inform(failed);
      resetForm();
      const priceNote = changes.length ? ` ${impactText(changes)}` : '';
      inform(unitWarning ? 'Ingrediente atualizado. Atenção: você mudou a unidade; revise as quantidades nas receitas antigas que o usam.'
        : measuresChanged && changes.length ? `Ingrediente atualizado. Atenção: as medidas mudaram o cálculo. ${impactText(changes)} Encomendas e custos já registrados não mudaram.`
        : `Ingrediente atualizado. Os custos das receitas foram recalculados.${priceNote}`);
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
  const draftIngredient = { densityGPerMl: cupGrams.trim() ? (parseQuantity(cupGrams) || undefined) && gramsPerCupToDensity(parseQuantity(cupGrams)!, cup) : undefined, gramsPerUnit: unitGrams.trim() ? parseQuantity(unitGrams) || undefined : undefined, catalogRef: effRef };
  const current = editingId ? data.ingredients.find(i => i.id === editingId) : undefined;
  const refUpdate = !!current?.catalogRef && catalogRef === current.catalogRef && updateAvailable(current);
  const apply = (d: MeasuresDraft) => { setCatalogRef(d.ref); setDeclined(!d.ref); setCupGrams(d.cup); setUnitGrams(d.unit); setAdjusting(false); };

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
          <MeasuresSummary ingredient={draftIngredient} cupSizeMl={cup} onAdjust={() => setAdjusting(true)} updateAvailable={refUpdate} />
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Adicionar ingrediente</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
        {adjusting && <MeasuresDialog ingredientName={name} cupSizeMl={cup} initial={{ ref: effRef, cup: cupGrams, unit: unitGrams }} updateAvailable={refUpdate} onUpdateReference={current ? () => updateReference(current) : undefined} onApply={apply} onCancel={() => setAdjusting(false)} />}
      </section>
      <section className="card"><h2 className="section-title">Ingredientes cadastrados ({data.ingredients.length})</h2>
        {data.ingredients.length ? <div className="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Compra</th><th>Preço</th><th></th></tr></thead><tbody>{data.ingredients.map(i => <tr key={i.id}><td>{i.name}</td><td>{i.purchaseQuantity} {i.unit}{measureLines(i, cup).map(l => <div key={l} className="muted" style={{ fontSize: 12 }}>{l}</div>)}</td><td>{money(i.purchasePrice)}</td><td style={{ whiteSpace: 'nowrap' }}><button aria-label={`Editar ${i.name}`} title="Editar" className="inline-icon" onClick={() => startEdit(i.id)}><Pencil size={15} /></button><button aria-label={`Excluir ${i.name}`} title="Excluir" className="inline-icon" onClick={() => removeIngredient(i.id)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty"><ShoppingBasket size={30} />Sua lista de ingredientes aparecerá aqui.</div>}
      </section>
    </div>
    <p className="footnote">Na receita você pode usar g, kg, mL, L, xícara, colheres e unidades; o app converte para a unidade de compra. Se faltar uma equivalência, o app avisa qual e não calcula o custo daquele ingrediente.</p>
  </>;
}
