import { useMemo, useState } from 'react';
import { ClipboardPaste, Plus, X } from 'lucide-react';
import type { Ingredient, MeasureUnit, RecipeItem } from '../../../domain/types';
import { REFERENCE_DISCLAIMER } from '../../measurement/densities';
import { formatQuantity, UNIT_ORDER, UNITS } from '../../measurement/units';
import { parseIngredientList } from '../parse';
import { analyzeRow, buildImport, rowFromParsed, type EquivalencePatch, type ImportRow } from '../resolve';

export type ImportConfirm = { items: RecipeItem[]; patches: EquivalencePatch[] };
type Props = { ingredients: Ingredient[]; cupSizeMl: number; onConfirm: (result: ImportConfirm) => void; onCancel: () => void };

const EXAMPLE = '2 ovos\n1 xícara (chá) de açúcar\n½ xícara (chá) de leite\n2 xícaras (chá) de farinha de trigo\n1 colher (sopa) de fermento químico\nÓleo para fritar';

export function RecipeTextImporter({ ingredients, cupSizeMl, onConfirm, onCancel }: Props) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const analyses = useMemo(() => (rows ?? []).map(r => analyzeRow(r, ingredients, cupSizeMl)), [rows, ingredients, cupSizeMl]);
  const plan = useMemo(() => buildImport(rows ?? [], ingredients, cupSizeMl), [rows, ingredients, cupSizeMl]);

  function interpret() {
    setRows(parseIngredientList(text).map((p, i) => rowFromParsed(p, i, ingredients)));
  }
  const edit = (id: number, change: Partial<ImportRow>) => setRows(rs => (rs ?? []).map(r => (r.id === id ? { ...r, ...change } : r)));

  return <div className="stack">
    <div><h2 className="section-title">Colar lista de ingredientes</h2><p className="muted">Cole os ingredientes de uma receita, um por linha. Nada é salvo até você confirmar.</p></div>
    <textarea aria-label="Lista de ingredientes" value={text} onChange={e => setText(e.target.value)} rows={6} placeholder={EXAMPLE} style={{ width: '100%', border: '1px solid #d9dee5', borderRadius: 10, padding: 12, font: 'inherit', resize: 'vertical' }} />
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="primary" disabled={!text.trim()} onClick={interpret}><ClipboardPaste size={17} /> Interpretar lista</button>
      <button type="button" className="secondary" onClick={onCancel}><X size={16} /> Fechar</button>
    </div>

    {rows && !rows.length && <div className="notice warn">Não encontrei nenhum ingrediente no texto.</div>}
    {rows && rows.length > 0 && <>
      <div className="table-wrap"><table style={{ minWidth: 860 }}>
        <thead><tr><th>Usar</th><th>Linha original</th><th>Quantidade</th><th>Medida</th><th>Ingrediente cadastrado</th><th>Convertido</th><th>Observações</th></tr></thead>
        <tbody>{rows.map((row, i) => {
          const a = analyses[i];
          return <tr key={row.id} style={{ verticalAlign: 'top' }}>
            <td><input type="checkbox" aria-label={`Usar ${row.parsed.raw}`} checked={row.include && a.ready} disabled={!a.ready} onChange={e => edit(row.id, { include: e.target.checked })} style={{ width: 18, height: 18 }} /></td>
            <td style={{ maxWidth: 200 }}>{row.parsed.raw}<div className="muted" style={{ fontSize: 12 }}>{a.ready ? <span className="tag green">Pronto</span> : <span className="tag orange">Revisar</span>}</div></td>
            <td><input className="cell-input" aria-label="Quantidade" inputMode="decimal" value={row.quantity} onChange={e => edit(row.id, { quantity: e.target.value })} style={{ width: 84 }} /></td>
            <td><select className="cell-input" aria-label="Medida" value={row.unit} onChange={e => edit(row.id, { unit: e.target.value as MeasureUnit | '' })} style={{ width: 150 }}><option value="">Escolher…</option>{UNIT_ORDER.map(u => <option key={u} value={u}>{UNITS[u].long}</option>)}</select></td>
            <td><select className="cell-input" aria-label="Ingrediente cadastrado" value={row.ingredientId} onChange={e => edit(row.id, { ingredientId: e.target.value })} style={{ width: 170 }}><option value="">Escolher…</option>{ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name}</option>)}</select></td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {a.grams === undefined && a.ml === undefined ? '—' : <>
                {a.grams !== undefined && <div><strong>{a.approximate ? '≈ ' : ''}{formatQuantity(a.grams, 'g')} g</strong></div>}
                {a.ml !== undefined && <div className="muted">{formatQuantity(a.ml, 'ml')} mL</div>}
              </>}
            </td>
            <td style={{ fontSize: 12, minWidth: 220 }}>
              {a.issues.map(m => <div key={m} style={{ color: '#9a5a0d' }}>{m}</div>)}
              {row.parsed.notes.filter(n => !a.issues.includes(n) && !n.startsWith('Quantidade indefinida') && !n.startsWith('Linha sem quantidade')).map(n => <div key={n} className="muted">{n}</div>)}
              {a.references.map(m => <div key={m} className="muted">{m}</div>)}
              {a.warnings.map(m => <div key={m} className="muted">{m}</div>)}
            </td>
          </tr>;
        })}</tbody>
      </table></div>
      <p className="footnote" style={{ margin: 0 }}>{REFERENCE_DISCLAIMER} Xícara = {cupSizeMl} mL (altere no Conversor). O cadastro do ingrediente tem prioridade sobre a referência.</p>
      {plan.patches.length > 0 && <div className="notice">Ao adicionar, vou gravar estas referências aproximadas no cadastro (você pode ajustá-las depois em Ingredientes):<ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{plan.patches.map(p => <li key={p.ingredientId}><strong>{p.name}</strong>: {p.description}</li>)}</ul></div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="primary" disabled={!plan.items.length} onClick={() => onConfirm({ items: plan.items, patches: plan.patches })}><Plus size={17} /> Adicionar {plan.items.length} {plan.items.length === 1 ? 'ingrediente' : 'ingredientes'} à receita</button>
        {plan.blocked > 0 && <span className="muted">{plan.blocked} linha(s) marcada(s) ainda precisam de revisão e não serão adicionadas.</span>}
      </div>
    </>}
  </div>;
}
