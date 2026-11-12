import { useId, useMemo, useState } from 'react';
import { Field } from '../../../components/Field';
import { Modal } from '../../../components/Modal';
import { effectiveEquivalence } from '../../../domain/equivalence';
import { parseQuantity } from '../../../domain/quantity';
import type { CatalogRef } from '../../../domain/types';
import { itemAndVariant, makeRef, searchCatalog, type CatalogItem } from '../catalog';
import { formatQuantity } from '../units';
import { IngredientCombobox } from './IngredientCombobox';

export type MeasuresDraft = { ref?: CatalogRef; cup: string; unit: string };
type Props = {
  ingredientName: string;
  cupSizeMl: number;
  initial: MeasuresDraft;
  /** Há atualização do catálogo para a referência (a tela de ingredientes cuida do efeito nas receitas). */
  updateAvailable?: boolean;
  onUpdateReference?: () => void;
  onApply: (draft: MeasuresDraft) => void;
  onCancel: () => void;
};

/**
 * Ajuste das medidas de UM ingrediente. Trabalha num rascunho: nada muda no cadastro até "Aplicar", e "Cancelar" descarta tudo.
 * Ação principal = Aplicar. "Restaurar" e "Remover referência" ficam em "Mais opções", com a consequência explicada.
 */
export function MeasuresDialog({ ingredientName, cupSizeMl, initial, updateAvailable, onUpdateReference, onApply, onCancel }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<MeasuresDraft>(initial);
  const found = draft.ref ? itemAndVariant(draft.ref) : undefined;
  const exact = useMemo(() => (draft.ref ? undefined : searchCatalog(ingredientName).exact), [draft.ref, ingredientName]);
  const refEq = effectiveEquivalence({ catalogRef: draft.ref });
  const cupHint = refEq.densityGPerMl ? `Referência: ≈ ${formatQuantity(refEq.densityGPerMl * cupSizeMl, 'g')}` : 'Ex.: 120';
  const unitHint = refEq.gramsPerUnit ? `Referência: ≈ ${formatQuantity(refEq.gramsPerUnit, 'g')}` : 'Ex.: 50 (um ovo)';
  const adopt = (item: CatalogItem) => setDraft(d => ({ ...d, ref: makeRef(item.id) }));
  const invalid = (t: string) => t.trim() !== '' && !((parseQuantity(t) ?? 0) > 0);
  const bad = invalid(draft.cup) || invalid(draft.unit);
  const hasCustom = draft.cup.trim() !== '' || draft.unit.trim() !== '';

  return <Modal titleId={id} title={<>Ajustar medidas</>} onClose={onCancel} closeLabel="Fechar sem salvar">
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>{ingredientName.trim() || 'Este ingrediente'}</p>
      {found ? <>
        <p style={{ margin: 0 }}><strong>{found.item.name}</strong> <span className="muted">· referência aproximada</span></p>
        {found.item.variants.length > 1 && <Field label="Apresentação"><select value={found.variant.id} onChange={e => setDraft(d => ({ ...d, ref: makeRef(found.item.id, e.target.value) }))}>{found.item.variants.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>}
        {found.variant.note && <p className="footnote" style={{ margin: 0 }}>{found.variant.note}</p>}
      </> : <>
        {exact && <div><button type="button" className="secondary" onClick={() => adopt(exact)}>Usar referência de “{exact.name}”</button></div>}
        <IngredientCombobox label="Buscar uma referência" onItem={adopt} placeholder="Ex.: açúcar de confeiteiro" emptyText="Não encontramos uma referência. Informe o peso abaixo, se quiser." />
      </>}
      <Field label="Quanto pesa uma xícara (em gramas)?"><input data-autofocus type="text" inputMode="decimal" value={draft.cup} onChange={e => setDraft(d => ({ ...d, cup: e.target.value }))} placeholder={cupHint} /></Field>
      <Field label="Quanto pesa uma unidade (em gramas)?"><input type="text" inputMode="decimal" value={draft.unit} onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))} placeholder={unitHint} /></Field>
      {bad && <p className="notice error" role="alert" style={{ margin: 0 }}>Use números maiores que zero, ou deixe em branco.</p>}
      {hasCustom && <p className="muted" style={{ margin: 0 }}>Você está usando uma medida personalizada.</p>}
      {found && <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>Ver fonte</summary><p className="footnote" style={{ margin: '6px 0 0' }}>USDA FoodData Central (SR Legacy), alimento “{found.variant.source.description}”, código {found.variant.source.fdcId}. Domínio público (CC0 1.0). Valores aproximados: variam com a marca e a forma de medir.</p></details>}
      {updateAvailable && onUpdateReference && <p style={{ margin: 0, fontSize: 13 }}>A referência do catálogo foi atualizada. <button type="button" className="link" onClick={onUpdateReference}>Ver efeito e atualizar</button></p>}
      {found && <details className="measures"><summary>Mais opções</summary>
        <div className="stack" style={{ gap: 12, marginTop: 10 }}>
          {hasCustom && <div><button type="button" className="secondary" onClick={() => setDraft(d => ({ ...d, cup: '', unit: '' }))}>Restaurar valores do catálogo</button><p className="footnote" style={{ margin: '6px 0 0' }}>Apaga as medidas que você informou e volta a usar a referência aproximada.</p></div>}
          <div><button type="button" className="link danger" onClick={() => setDraft(d => ({ ...d, ref: undefined }))}>Remover referência</button><p className="footnote" style={{ margin: '6px 0 0' }}>Desfaz a associação com “{found.item.name}”. As medidas que você informou continuam; sem elas, o ingrediente fica sem medidas.</p></div>
        </div></details>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>
        <button type="button" className="primary" disabled={bad} onClick={() => onApply(draft)}>Aplicar</button>
      </div>
    </div>
  </Modal>;
}
