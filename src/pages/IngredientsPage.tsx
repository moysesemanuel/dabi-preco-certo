import { useMemo, useState, type FormEvent } from 'react';
import { Pencil, Plus, Save, ShoppingBasket, Trash2, X } from 'lucide-react';
import { unitChangeAffectsRecipes, updateIngredient } from '../domain/edit';
import { effectiveEquivalence } from '../domain/equivalence';
import { costImpact } from '../domain/impact';
import { money } from '../domain/pricing';
import { parseQuantity } from '../domain/quantity';
import type { CatalogRef, DataSet, Ingredient, Unit } from '../domain/types';
import { Field } from '../components/Field';
import { CATALOG_VERSION, findVariant, itemAndVariant, makeRef, refDiffersFromCatalog, searchCatalog, type CatalogItem } from '../features/measurement/catalog';
import { IngredientCombobox } from '../features/measurement/components/IngredientCombobox';
import { densityToGramsPerCup, gramsPerCupToDensity, REFERENCE_DISCLAIMER } from '../features/measurement/densities';
import { formatQuantity } from '../features/measurement/units';
import { isMoney, isPositiveQuantity, toCents2 } from '../domain/money';
import { cupSizeOf, newId, parse, tryApply, units, type PageProps } from '../utils';

const brl = (n?: number) => (n === undefined ? 'não calculável' : money(n));
/** Frase curta com as receitas cujo custo mudou. */
function impactText(changes: ReturnType<typeof costImpact>): string {
  const shown = changes.slice(0, 3).map(c => `${c.name} (${brl(c.before)} → ${brl(c.after)})`).join('; ');
  return `${changes.length} ${changes.length === 1 ? 'receita mudou' : 'receitas mudaram'} de custo por unidade: ${shown}${changes.length > 3 ? '…' : ''}.`;
}
const refSummary = (i: Pick<Ingredient, 'densityGPerMl' | 'gramsPerUnit' | 'catalogRef'>, cup: number) => {
  const eq = effectiveEquivalence(i);
  const lines: string[] = [];
  if (eq.densityGPerMl) lines.push(`1 xícara ≈ ${formatQuantity(densityToGramsPerCup(eq.densityGPerMl, cup), 'g')} g (${eq.densitySource === 'custom' ? 'informado por você' : 'referência'})`);
  if (eq.gramsPerUnit) lines.push(`1 un. ≈ ${formatQuantity(eq.gramsPerUnit, 'g')} g (${eq.unitSource === 'custom' ? 'informado por você' : 'referência'})`);
  return lines;
};

export function IngredientsPage({ data, update, inform }: PageProps) {
  const cup = cupSizeOf(data);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [qty, setQty] = useState('1000');
  const [price, setPrice] = useState('');
  const [cupGrams, setCupGrams] = useState('');
  const [unitGrams, setUnitGrams] = useState('');
  const [catalogRef, setCatalogRef] = useState<CatalogRef | undefined>();
  const [variantFor, setVariantFor] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [measuresOpen, setMeasuresOpen] = useState(false);
  const search = useMemo(() => (catalogRef ? { suggestions: [] as CatalogItem[] } : searchCatalog(name)), [name, catalogRef]);
  const adopted = catalogRef ? itemAndVariant(catalogRef) : undefined;

  function resetForm() { setEditingId(null); setName(''); setUnit('g'); setQty('1000'); setPrice(''); setCupGrams(''); setUnitGrams(''); setCatalogRef(undefined); setVariantFor({}); setMeasuresOpen(false); }
  function startEdit(id: string) {
    const i = data.ingredients.find(x => x.id === id);
    if (!i) return;
    setEditingId(i.id); setName(i.name); setUnit(i.unit); setQty(String(i.purchaseQuantity)); setPrice(String(i.purchasePrice));
    setCupGrams(i.densityGPerMl ? String(Number(densityToGramsPerCup(i.densityGPerMl, cup).toFixed(2))) : '');
    setUnitGrams(i.gramsPerUnit ? String(i.gramsPerUnit) : '');
    setCatalogRef(i.catalogRef); setMeasuresOpen(!!(i.catalogRef || i.densityGPerMl || i.gramsPerUnit));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const adopt = (item: CatalogItem, variantId?: string) => { setCatalogRef(makeRef(item.id, variantId ?? variantFor[item.id])); setMeasuresOpen(true); };
  function updateAvailable(i: Ingredient) { return !!i.catalogRef && i.catalogRef.version !== CATALOG_VERSION && refDiffersFromCatalog(i.catalogRef); }
  function updateReference(i: Ingredient) {
    const fresh = makeRef(i.catalogRef!.id, i.catalogRef!.variant); if (!fresh) return;
    const { id: _id, ...rest } = i;
    const after: DataSet = updateIngredient(data, i.id, { ...rest, catalogRef: fresh });
    const changes = costImpact(data, after);
    if (!confirm(`Atualizar a referência de medidas de “${i.name}” para a versão ${CATALOG_VERSION} do catálogo?${changes.length ? `\n\nIsto muda o custo: ${impactText(changes)}` : '\n\nNenhuma receita muda de custo.'}\n\nEncomendas e custos já registrados não são alterados.`)) return;
    update(() => after); inform(changes.length ? `Referência atualizada. ${impactText(changes)}` : 'Referência atualizada. Nenhum custo mudou.');
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
      ...(catalogRef ? { catalogRef } : {}),
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
  const preview = refSummary({ densityGPerMl: cupGrams.trim() ? (parseQuantity(cupGrams) ?? 0) / cup || undefined : undefined, gramsPerUnit: unitGrams.trim() ? parseQuantity(unitGrams) : undefined, catalogRef }, cup);
  const current = editingId ? data.ingredients.find(i => i.id === editingId) : undefined;

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
          {!catalogRef && search.exact && <div className="notice" role="status" style={{ display: 'grid', gap: 8 }}>
            <span>Encontramos medidas de referência para <strong>{search.exact.name}</strong>. Assim você já pode usar xícaras e colheres nas receitas.</span>
            {search.exact.variants.length > 1 && <Field label="Apresentação"><select value={variantFor[search.exact.id] ?? findVariant(search.exact).id} onChange={e => setVariantFor(v => ({ ...v, [search.exact!.id]: e.target.value }))}>{search.exact.variants.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>}
            <div><button type="button" className="secondary" style={{ minHeight: 36 }} onClick={() => adopt(search.exact!)}>Usar medidas de referência</button></div></div>}
          {!catalogRef && !search.exact && search.suggestions.length > 0 && <div className="stack" style={{ gap: 6 }} role="group" aria-label="Medidas de referência parecidas">
            <span className="form-subtitle" style={{ margin: 0 }}>Medidas de referência parecidas (toque para usar):</span>
            <div className="chips">{search.suggestions.slice(0, 5).map(c => <button type="button" key={c.id} className="chip" onClick={() => adopt(c)}>{c.name}</button>)}</div></div>}
          <details className="measures" open={measuresOpen} onToggle={e => setMeasuresOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Medidas e equivalências <span className="muted" style={{ fontWeight: 400 }}>(opcional){adopted ? ` · referência: ${adopted.item.name}` : cupGrams || unitGrams ? ' · ajustada por você' : ''}</span></summary>
            <div className="stack" style={{ gap: 12, marginTop: 10 }}>
              {adopted ? <div className="notice" style={{ display: 'grid', gap: 6 }}>
                <span><strong>{adopted.item.name}</strong>{adopted.item.variants.length > 1 ? ` · ${adopted.variant.label}` : ''} <span className="tag gray">valor aproximado</span></span>
                {adopted.item.variants.length > 1 && <Field label="Apresentação"><select value={adopted.variant.id} onChange={e => setCatalogRef(makeRef(adopted.item.id, e.target.value))}>{adopted.item.variants.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>}
                {adopted.variant.note && <span className="muted" style={{ fontSize: 12 }}>{adopted.variant.note}</span>}
                <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>Ver fonte</summary><p className="footnote" style={{ margin: '6px 0 0' }}>USDA FoodData Central (SR Legacy), alimento “{adopted.variant.source.description}” (FDC {adopted.variant.source.fdcId}); domínio público (CC0 1.0). Referência adotada na versão {catalogRef!.version} do catálogo. As pessoas medem de formas diferentes: ajuste abaixo se o seu ingrediente pesar diferente.</p></details>
                <div><button type="button" className="secondary" style={{ minHeight: 34 }} onClick={() => setCatalogRef(undefined)}>Remover referência</button></div></div>
                : <><p className="form-subtitle" style={{ margin: 0 }}>{name.trim().length >= 3 && !search.exact && !search.suggestions.length ? 'Não encontramos uma referência para este ingrediente. Você pode continuar normalmente ou informar os pesos abaixo.' : 'Se quiser usar xícaras, colheres ou unidades nas receitas, escolha uma referência ou informe os pesos.'}</p>
                  <IngredientCombobox label="Buscar medidas de referência" onItem={c => adopt(c)} placeholder="Ex.: açúcar de confeiteiro" /></>}
              {current?.catalogRef && catalogRef === current.catalogRef && updateAvailable(current) && <div className="notice warn" style={{ display: 'grid', gap: 6 }}><span>O catálogo foi atualizado e esta referência é de uma versão anterior. Os seus custos continuam como estão.</span><div><button type="button" className="secondary" style={{ minHeight: 34 }} onClick={() => updateReference(current)}>Ver o efeito e atualizar</button></div></div>}
              <Field label="Quanto pesa uma xícara (em gramas)?"><input type="text" inputMode="decimal" value={cupGrams} onChange={e => setCupGrams(e.target.value)} placeholder={adopted && effectiveEquivalence({ catalogRef }).densityGPerMl ? `Referência: ≈ ${formatQuantity(effectiveEquivalence({ catalogRef }).densityGPerMl! * cup, 'g')}` : 'Ex.: 120'} /></Field>
              <Field label="Quanto pesa uma unidade (em gramas)?"><input type="text" inputMode="decimal" value={unitGrams} onChange={e => setUnitGrams(e.target.value)} placeholder={adopted && catalogRef?.gramsPerUnit ? `Referência: ≈ ${formatQuantity(catalogRef.gramsPerUnit, 'g')}` : 'Ex.: 50 (um ovo)'} /></Field>
              {(cupGrams || unitGrams) && <div className="notice" style={{ display: 'grid', gap: 6 }}><span>O valor que você informou vale mais do que a referência.</span>{catalogRef && <div><button type="button" className="secondary" style={{ minHeight: 34 }} onClick={() => { setCupGrams(''); setUnitGrams(''); }}>Restaurar referência</button></div>}</div>}
              {preview.length > 0 && <p className="form-subtitle" style={{ margin: 0 }}>{preview.join(' · ')}. {REFERENCE_DISCLAIMER}</p>}
            </div>
          </details>
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" type="submit">{editingId ? <><Save size={17} /> Salvar alterações</> : <><Plus size={17} /> Adicionar ingrediente</>}</button>{editingId && <button className="secondary" type="button" onClick={resetForm}><X size={16} /> Cancelar</button>}</div>
        </form>
      </section>
      <section className="card"><h2 className="section-title">Ingredientes cadastrados ({data.ingredients.length})</h2>
        {data.ingredients.length ? <div className="table-wrap"><table><thead><tr><th>Ingrediente</th><th>Compra</th><th>Preço</th><th></th></tr></thead><tbody>{data.ingredients.map(i => <tr key={i.id}><td>{i.name}</td><td>{i.purchaseQuantity} {i.unit}{refSummary(i, cup).map(l => <div key={l} className="muted" style={{ fontSize: 12 }}>{l}</div>)}</td><td>{money(i.purchasePrice)}</td><td style={{ whiteSpace: 'nowrap' }}><button aria-label={`Editar ${i.name}`} title="Editar" className="inline-icon" onClick={() => startEdit(i.id)}><Pencil size={15} /></button><button aria-label={`Excluir ${i.name}`} title="Excluir" className="inline-icon" onClick={() => removeIngredient(i.id)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div> : <div className="empty"><ShoppingBasket size={30} />Sua lista de ingredientes aparecerá aqui.</div>}
      </section>
    </div>
    <p className="footnote">Na receita você pode usar g, kg, mL, L, xícara, colheres e unidades; o app converte para a unidade de compra. Se faltar uma equivalência, o app avisa qual e não calcula o custo daquele ingrediente. Medidas de referência: USDA FoodData Central (domínio público); valores aproximados.</p>
  </>;
}
