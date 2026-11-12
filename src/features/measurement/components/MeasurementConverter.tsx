import { useMemo, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { parseQuantity } from '../../../domain/quantity';
import type { Ingredient, MeasureUnit } from '../../../domain/types';
import { Field } from '../../../components/Field';
import { findVariant, type CatalogItem } from '../catalog';
import { convert, CUP_SIZES_ML, type ConversionResult } from '../convert';
import { REFERENCE_DISCLAIMER } from '../densities';
import { subjectFromCatalog, subjectFromIngredient, type Subject } from '../subject';
import { dimensionOf, formatQuantity, UNIT_ORDER, UNITS, unitText } from '../units';
import { IngredientCombobox } from './IngredientCombobox';

export type ConverterUse = { ingredientId: string; quantity: number; unit: MeasureUnit };
type Props = {
  ingredients: Ingredient[];
  cupSizeMl: number;
  onCupSizeChange: (cupSizeMl: number) => void;
  /** Só informado quando há uma receita em edição; sem ele o botão "Usar na receita" não aparece. */
  onUse?: (use: ConverterUse) => void;
};
type Pick = { kind: 'ingredient'; ingredient: Ingredient } | { kind: 'item'; item: CatalogItem; variantId: string };

/** Frase "1 xícara de X ≈ N g" para a conversão em questão (ou da convenção, se for só medida culinária). */
function referenceText(from: MeasureUnit, to: MeasureUnit, subject: Subject | null, cup: number): string {
  const dims = [dimensionOf(from), dimensionOf(to)];
  if (subject?.densityGPerMl && dims.includes('mass') && dims.includes('volume')) {
    const vol = [from, to].find(u => dimensionOf(u) === 'volume')!;
    const ml = vol === 'xic' ? cup : vol === 'cs' ? 15 : vol === 'cc' ? 5 : vol === 'l' ? 1000 : 1;
    return `${vol === 'ml' ? '1 mL' : vol === 'l' ? '1 L' : `1 ${UNITS[vol].singular}`} de ${subject.label} ≈ ${formatQuantity(subject.densityGPerMl * ml, 'g')} g${vol === 'xic' ? ` (xícara de ${cup} mL)` : ''}`;
  }
  if (subject?.gramsPerUnit && dims.includes('count') && dims.includes('mass')) return `1 unidade de ${subject.label} ≈ ${formatQuantity(subject.gramsPerUnit, 'g')} g`;
  return '';
}

function errorText(r: Extract<ConversionResult, { success: false }>, from: MeasureUnit, to: MeasureUnit, subject: Subject | null): string {
  const dims = [dimensionOf(from), dimensionOf(to)];
  if (r.error === 'INVALID_QUANTITY') return 'Informe uma quantidade válida, como 2, 1,5 ou 1/2.';
  if (r.error === 'INVALID_CONFIGURATION') return 'Configuração inválida (tamanho da xícara ou medida ajustada).';
  if (dims.includes('count') && dims.includes('volume')) return 'Não há como converter unidade em volume. Converta a unidade em gramas.';
  const what = r.error === 'MISSING_DENSITY' ? 'quanto pesa uma xícara' : 'quanto pesa uma unidade';
  if (!subject) return r.error === 'MISSING_DENSITY' ? 'Para converter entre peso e volume, escolha um ingrediente.' : 'Para converter unidade em peso, escolha um ingrediente.';
  return `Não encontramos uma referência de ${what} para ${subject.label}. Use “Ajustar medida” para informar o valor.`;
}

export function MeasurementConverter({ ingredients, cupSizeMl, onCupSizeChange, onUse }: Props) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [qty, setQty] = useState('1');
  const [from, setFrom] = useState<MeasureUnit>('xic');
  const [to, setTo] = useState<MeasureUnit>('g');
  const [myCup, setMyCup] = useState('');
  const [myUnit, setMyUnit] = useState('');

  const base = useMemo<Subject | null>(() => (!pick ? null : pick.kind === 'ingredient' ? subjectFromIngredient(pick.ingredient) : subjectFromCatalog(pick.item, pick.variantId)), [pick]);
  const cupGrams = parseQuantity(myCup), unitGrams = parseQuantity(myUnit);
  const adjusted = (cupGrams !== undefined && cupGrams > 0) || (unitGrams !== undefined && unitGrams > 0);
  // O valor ajustado vale só para esta conversão e tem prioridade sobre a referência.
  const subject: Subject | null = base || adjusted ? {
    ...(base ?? { key: 'ajustado', label: 'o ingrediente', densitySource: 'none' as const, unitSource: 'none' as const }),
    ...(cupGrams && cupGrams > 0 ? { densityGPerMl: cupGrams / cupSizeMl, densitySource: 'custom' as const } : {}),
    ...(unitGrams && unitGrams > 0 ? { gramsPerUnit: unitGrams, unitSource: 'custom' as const } : {}),
  } : null;

  const quantity = parseQuantity(qty);
  const hasInput = qty.trim() !== '';
  const result: ConversionResult | null = hasInput ? (quantity === undefined ? { success: false, error: 'INVALID_QUANTITY' } : convert({ quantity, from, to, densityGPerMl: subject?.densityGPerMl, gramsPerUnit: subject?.gramsPerUnit, cupSizeMl })) : null;
  const unitOptions = UNIT_ORDER.map(u => <option key={u} value={u}>{UNITS[u].long}</option>);
  const reference = result?.success ? referenceText(from, to, subject, cupSizeMl) : '';
  const usedCustom = result?.success && result.basis === 'reference' && ((dimensionOf(from) === 'count' || dimensionOf(to) === 'count') ? subject?.unitSource : subject?.densitySource) === 'custom';
  const canUse = !!onUse && !!pick && pick.kind === 'ingredient' && result?.success === true && !adjusted;
  const variant = pick?.kind === 'item' ? findVariant(pick.item, pick.variantId) : undefined;

  return <div className="stack">
    <IngredientCombobox label="Ingrediente (opcional para medidas da mesma natureza)" ingredients={ingredients} onIngredient={i => { setPick({ kind: 'ingredient', ingredient: i }); setMyCup(''); setMyUnit(''); }}
      onItem={item => { setPick({ kind: 'item', item, variantId: findVariant(item).id }); setMyCup(''); setMyUnit(''); }} />
    {pick && <div className="notice" style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span><strong>{base?.label}</strong>{base?.reference && pick.kind === 'ingredient' ? <> · referência: {base.reference}</> : null}{pick.kind === 'ingredient' && base?.densitySource === 'none' && base.unitSource === 'none' ? <> · sem medidas cadastradas</> : null}</span>
      <button type="button" className="secondary" style={{ minHeight: 34 }} onClick={() => { setPick(null); setMyCup(''); setMyUnit(''); }} aria-label="Limpar ingrediente"><X size={14} /> Limpar</button>
    </div>}
    {pick?.kind === 'item' && pick.item.variants.length > 1 && <Field label="Apresentação"><select value={pick.variantId} onChange={e => setPick({ ...pick, variantId: e.target.value })}>{pick.item.variants.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>}
    {variant?.note && <p className="form-subtitle" style={{ margin: 0 }}>{variant.note}</p>}

    <div className="form-grid">
      <Field label="Quantidade"><input type="text" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} aria-label="Quantidade" placeholder="Ex.: 2, 1,5 ou 1/2" /></Field>
      <Field label="Tamanho da xícara"><select value={cupSizeMl} onChange={e => onCupSizeChange(Number(e.target.value))}>{CUP_SIZES_ML.map(c => <option key={c} value={c}>{c} mL</option>)}</select></Field>
      <Field label="De"><select value={from} onChange={e => setFrom(e.target.value as MeasureUnit)} aria-label="Unidade de origem">{unitOptions}</select></Field>
      <Field label="Para"><select value={to} onChange={e => setTo(e.target.value as MeasureUnit)} aria-label="Unidade de destino">{unitOptions}</select></Field>
    </div>
    <button type="button" className="secondary" style={{ justifySelf: 'start' }} onClick={() => { setFrom(to); setTo(from); }}>Inverter conversão</button>

    <div className="formula" aria-live="polite">
      <span className="metric-label">RESULTADO</span>
      {!result ? <p className="muted">Informe uma quantidade.</p>
        : result.success ? <>
          <div style={{ textAlign: 'center', fontSize: 30, fontWeight: 800, fontFamily: 'Manrope, Inter, sans-serif' }}>{result.basis === 'reference' ? '≈ ' : ''}{formatQuantity(result.value, to)} {unitText(to, result.value)}</div>
          <p style={{ margin: 0, textAlign: 'center' }}><span className={`tag ${result.basis === 'exact' ? 'green' : 'orange'}`}>{result.basis === 'exact' ? 'Conversão exata' : result.basis === 'convention' ? 'Medida culinária convencional' : usedCustom ? 'Aproximado · valor informado por você' : 'Aproximado · referência do catálogo'}</span></p>
          {reference && <p className="muted" style={{ margin: 0 }}>Referência: {reference}{usedCustom ? ' (informado por você)' : ''}</p>}
          {result.basis === 'convention' && <p className="footnote" style={{ margin: 0 }}>1 xícara = {cupSizeMl} mL · 1 colher de sopa = 15 mL · 1 colher de chá = 5 mL. São convenções culinárias, não medidas físicas exatas.</p>}
          {result.basis === 'reference' && <p className="footnote" style={{ margin: 0 }}>{REFERENCE_DISCLAIMER}</p>}
        </>
        : <div className="notice warn" role="alert">{errorText(result, from, to, subject)}</div>}
    </div>

    <details className="measures">
      <summary>Ajustar medida (só para esta conversão)</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <Field label={`Quanto pesa 1 xícara (${cupSizeMl} mL), em gramas?`}><input type="text" inputMode="decimal" value={myCup} onChange={e => setMyCup(e.target.value)} placeholder={base?.densityGPerMl ? `Referência: ≈ ${formatQuantity(base.densityGPerMl * cupSizeMl, 'g')}` : 'Ex.: 120'} /></Field>
        <Field label="Quanto pesa 1 unidade, em gramas?"><input type="text" inputMode="decimal" value={myUnit} onChange={e => setMyUnit(e.target.value)} placeholder={base?.gramsPerUnit ? `Referência: ≈ ${formatQuantity(base.gramsPerUnit, 'g')}` : 'Ex.: 50'} /></Field>
        {adjusted && <div><button type="button" className="secondary" onClick={() => { setMyCup(''); setMyUnit(''); }}>Usar a referência</button></div>}
        {base?.sourceNote && <p className="footnote" style={{ margin: 0 }}>Fonte: {base.sourceNote}</p>}
      </div>
    </details>

    {onUse && <button type="button" className="primary" disabled={!canUse}
      onClick={() => { if (pick?.kind === 'ingredient' && result?.success) onUse({ ingredientId: pick.ingredient.id, quantity: Number(result.value.toFixed(6)), unit: to }); }}>
      <ArrowRight size={16} /> Usar na receita
    </button>}
    {onUse && !canUse && <p className="form-subtitle">{adjusted ? 'Para usar na receita, salve o valor ajustado no cadastro do ingrediente.' : 'Escolha um dos seus ingredientes cadastrados para poder usar o resultado na receita.'}</p>}
  </div>;
}
