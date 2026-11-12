import { effectiveEquivalence } from '../../../domain/equivalence';
import type { Ingredient } from '../../../domain/types';
import { itemAndVariant } from '../catalog';
import { densityToGramsPerCup } from '../densities';
import { formatQuantity } from '../units';

type Eq = Pick<Ingredient, 'densityGPerMl' | 'gramsPerUnit' | 'catalogRef'>;

/** Linhas de equivalência que o motor de cálculo realmente usa: "=" para medida personalizada, "≈" para referência aproximada. */
export function measureLines(i: Eq, cup: number): string[] {
  const eq = effectiveEquivalence(i), lines: string[] = [];
  if (eq.densityGPerMl) lines.push(`1 xícara ${eq.densitySource === 'custom' ? '=' : '≈'} ${formatQuantity(densityToGramsPerCup(eq.densityGPerMl, cup), 'g')} g`);
  if (eq.gramsPerUnit) lines.push(`1 unidade ${eq.unitSource === 'custom' ? '=' : '≈'} ${formatQuantity(eq.gramsPerUnit, 'g')} g`);
  return lines;
}

type Props = { ingredient: Eq; cupSizeMl: number; onAdjust: () => void; /** há atualização do catálogo para esta referência */ updateAvailable?: boolean };

/**
 * Resumo discreto das medidas de um ingrediente (o que vale nos cálculos). Três estados: referência aproximada,
 * medida personalizada ou nenhuma medida. Sem IDs, versões nem campos de edição: o ajuste fica sob demanda.
 */
export function MeasuresSummary({ ingredient, cupSizeMl, onAdjust, updateAvailable }: Props) {
  const eq = effectiveEquivalence(ingredient), lines = measureLines(ingredient, cupSizeMl);
  const custom = eq.densitySource === 'custom' || eq.unitSource === 'custom';
  const found = ingredient.catalogRef ? itemAndVariant(ingredient.catalogRef) : undefined;
  const presentation = found && found.item.variants.length > 1 ? found.variant.label : undefined;
  const title = lines.length === 0 ? 'Medidas não disponíveis' : custom ? 'Medida personalizada' : 'Medidas encontradas';
  const sub = lines.length === 0 ? 'Você pode cadastrar este ingrediente normalmente.'
    : custom ? (eq.densitySource === 'catalog' || eq.unitSource === 'catalog' ? 'As demais medidas usam a referência aproximada.' : undefined)
    : `Referência culinária aproximada${presentation ? ` · ${presentation}` : ''}`;
  return <div className="measure-summary" role="group" aria-label="Medidas do ingrediente">
    <div className="measure-summary-text">
      <strong>{title}</strong>
      {lines.length > 0 && <span className="measure-lines">{lines.join(' · ')}</span>}
      {sub && <span className="muted">{sub}</span>}
      {updateAvailable && <span className="muted">Há uma atualização da referência. Veja em Ajustar.</span>}
    </div>
    <button type="button" className="secondary" onClick={onAdjust}>{lines.length === 0 ? 'Adicionar medida' : 'Ajustar'}</button>
  </div>;
}
