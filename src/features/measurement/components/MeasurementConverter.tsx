import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { Ingredient, MeasureUnit } from '../../../domain/types';
import { Field } from '../../../components/Field';
import { parse } from '../../../utils';
import { convert, conversionErrorMessage, CUP_SIZES_ML } from '../convert';
import { densityToGramsPerCup, REFERENCE_DISCLAIMER } from '../densities';
import { dimensionOf, formatQuantity, UNIT_ORDER, UNITS, unitText } from '../units';

export type ConverterUse = { ingredientId: string; quantity: number; unit: MeasureUnit };
type Props = {
  ingredients: Ingredient[];
  cupSizeMl: number;
  onCupSizeChange: (cupSizeMl: number) => void;
  /** Só informado quando há uma receita em edição; sem ele o botão "Usar na receita" não aparece. */
  onUse?: (use: ConverterUse) => void;
};

function referenceText(from: MeasureUnit, to: MeasureUnit, ing: Ingredient | undefined, cup: number): string {
  const dims = [dimensionOf(from), dimensionOf(to)];
  if (ing && dims.includes('mass') && dims.includes('volume') && ing.densityGPerMl) return `1 xícara de ${ing.name} = ${formatQuantity(densityToGramsPerCup(ing.densityGPerMl, cup), 'g')} g (xícara de ${cup} mL)`;
  if (ing && dims.includes('count') && ing.gramsPerUnit && dims.includes('mass')) return `1 unidade de ${ing.name} = ${formatQuantity(ing.gramsPerUnit, 'g')} g`;
  const culinary = [from, to].find(u => UNITS[u].approximate);
  if (culinary) return `1 ${UNITS[culinary].singular} = ${culinary === 'xic' ? cup : culinary === 'cs' ? 15 : 5} mL`;
  return '';
}

export function MeasurementConverter({ ingredients, cupSizeMl, onCupSizeChange, onUse }: Props) {
  const [ingredientId, setIngredientId] = useState('');
  const [qty, setQty] = useState('1');
  const [from, setFrom] = useState<MeasureUnit>('xic');
  const [to, setTo] = useState<MeasureUnit>('g');
  const ing = ingredients.find(i => i.id === ingredientId);
  const quantity = parse(qty);
  const hasInput = qty.trim() !== '';
  const result = hasInput ? convert({ quantity, from, to, densityGPerMl: ing?.densityGPerMl, gramsPerUnit: ing?.gramsPerUnit, cupSizeMl }) : null;
  const unitOptions = UNIT_ORDER.map(u => <option key={u} value={u}>{UNITS[u].long}</option>);
  const reference = result?.success ? referenceText(from, to, ing, cupSizeMl) : '';

  return <div className="stack">
    <Field label="Ingrediente (opcional para medidas da mesma natureza)"><select value={ingredientId} onChange={e => setIngredientId(e.target.value)}><option value="">Nenhum</option>{ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
    <div className="form-grid">
      <Field label="Quantidade"><input type="text" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} aria-label="Quantidade" /></Field>
      <Field label="Tamanho da xícara"><select value={cupSizeMl} onChange={e => onCupSizeChange(Number(e.target.value))}>{CUP_SIZES_ML.map(c => <option key={c} value={c}>{c} mL</option>)}</select></Field>
      <Field label="De"><select value={from} onChange={e => setFrom(e.target.value as MeasureUnit)} aria-label="Unidade de origem">{unitOptions}</select></Field>
      <Field label="Para"><select value={to} onChange={e => setTo(e.target.value as MeasureUnit)} aria-label="Unidade de destino">{unitOptions}</select></Field>
    </div>
    <div className="formula" aria-live="polite">
      <span className="metric-label">RESULTADO</span>
      {!result ? <p className="muted">Informe uma quantidade.</p>
        : result.success ? <>
          <div style={{ textAlign: 'center', fontSize: 30, fontWeight: 800, fontFamily: 'Manrope, Inter, sans-serif' }}>{result.approximate ? '≈ ' : ''}{formatQuantity(result.value, to)} {unitText(to, result.value)}</div>
          {reference && <p className="muted" style={{ margin: 0 }}>Referência: {reference}</p>}
          {result.approximate && <p className="footnote" style={{ margin: 0 }}>{REFERENCE_DISCLAIMER}</p>}
        </>
        : <div className="notice warn">{conversionErrorMessage(result.error, from, to, ing?.name)}</div>}
    </div>
    {onUse && <button type="button" className="primary" disabled={!ing || !result?.success} title={!ing ? 'Escolha um ingrediente para usar na receita' : undefined}
      onClick={() => { if (ing && result?.success) onUse({ ingredientId: ing.id, quantity: Number(result.value.toFixed(6)), unit: to }); }}>
      <ArrowRight size={16} /> Usar na receita
    </button>}
    {onUse && !ing && <p className="form-subtitle">Escolha um ingrediente para poder usar o resultado na receita.</p>}
  </div>;
}
