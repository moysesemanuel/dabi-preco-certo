import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Ingredient } from '../../../domain/types';
import { normalizeText, searchCatalog, type CatalogItem } from '../catalog';

type Option = { key: string; text: string; hint: string; pick: () => void };
type Props = {
  label: string;
  /** Ingredientes cadastrados pelo usuário (opcional): aparecem antes do catálogo. */
  ingredients?: Ingredient[];
  onIngredient?: (i: Ingredient) => void;
  onItem: (item: CatalogItem) => void;
  placeholder?: string;
  /** Texto quando a busca não encontra nada. */
  emptyText?: string;
};

/**
 * Busca de ingrediente (seus cadastros e catálogo de medidas) com teclado: ↑/↓ navegam, Enter escolhe, Esc fecha.
 * Funciona sem rede. Nunca escolhe sozinho: toda correspondência por semelhança é só uma sugestão.
 */
export function IngredientCombobox({ label, ingredients = [], onIngredient, onItem, placeholder = 'Ex.: farinha de trigo', emptyText = 'Não encontramos uma referência para este ingrediente.' }: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = useMemo<Option[]>(() => {
    const q = normalizeText(query); if (q.length < 2) return [];
    const tokens = q.split(' ');
    const mine = onIngredient ? ingredients.filter(i => { const n = normalizeText(i.name); return tokens.every(t => n.split(' ').some(w => w.startsWith(t))); }).slice(0, 5)
      .map<Option>(i => ({ key: `i:${i.id}`, text: i.name, hint: 'Seu ingrediente', pick: () => onIngredient(i) })) : [];
    const { exact, suggestions } = searchCatalog(query);
    const cat = [...(exact ? [exact] : []), ...suggestions].map<Option>(c => ({ key: `c:${c.id}`, text: c.name, hint: c.variants.length > 1 ? `Catálogo · ${c.variants.length} apresentações` : 'Catálogo', pick: () => onItem(c) }));
    return [...mine, ...cat];
  }, [query, ingredients, onIngredient, onItem]);
  const choose = (o: Option) => { o.pick(); setQuery(''); setOpen(false); setActive(0); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, Math.max(options.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };
  const showList = open && options.length > 0;
  const showEmpty = open && normalizeText(query).length >= 2 && options.length === 0;
  return <div className="combo">
    <label htmlFor={`${id}-in`}>{label}</label>
    <input id={`${id}-in`} role="combobox" aria-expanded={showList} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={showList ? `${id}-o${active}` : undefined}
      autoComplete="off" value={query} placeholder={placeholder} onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKey} />
    {showList && <ul id={`${id}-list`} role="listbox" aria-label={`Resultados para ${label}`} className="combo-list">
      {options.map((o, n) => <li key={o.key} id={`${id}-o${n}`} role="option" aria-selected={n === active} className={n === active ? 'active' : undefined} onMouseDown={e => { e.preventDefault(); choose(o); }}><span>{o.text}</span>{' '}<small>{o.hint}</small></li>)}
    </ul>}
    {showEmpty && <p className="form-subtitle" role="status" style={{ margin: '6px 0 0' }}>{emptyText}</p>}
  </div>;
}
