/** Textos em português para mostrar um conflito: nome da entidade, campos que divergem e valores formatados. */
import { findItem, findVariant } from '../features/measurement/catalog';
import type { Packaging } from '../domain/types';
import type { ConflictRecord } from './engine';

export const KIND_LABEL: Record<ConflictRecord['kind'], string> = { ingredients: 'ingrediente', recipes: 'receita', orders: 'encomenda', packagings: 'embalagem', settings: 'configurações' };
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FIELD: Record<string, { label: string; money?: boolean }> = {
  name: { label: 'Nome' }, unit: { label: 'Unidade' }, purchaseQuantity: { label: 'Quantidade comprada' }, purchasePrice: { label: 'Preço', money: true },
  densityGPerMl: { label: 'Densidade (g/ml)' }, gramsPerUnit: { label: 'Gramas por unidade' },
  yield: { label: 'Rendimento' }, items: { label: 'Ingredientes da receita' }, packagingItems: { label: 'Embalagens da receita' }, packagingPerUnit: { label: 'Embalagem por unidade', money: true }, laborTotal: { label: 'Mão de obra', money: true },
  extraTotal: { label: 'Custos extras', money: true }, desiredMargin: { label: 'Margem desejada (%)' }, prepMinutes: { label: 'Minutos de preparo' },
  customer: { label: 'Cliente' }, recipeId: { label: 'Receita' }, quantity: { label: 'Quantidade' }, unitPrice: { label: 'Preço unitário', money: true }, deliveryDate: { label: 'Entrega' }, packagingCharge: { label: 'Cobrança de embalagens', money: true },
  status: { label: 'Situação' }, deposit: { label: 'Sinal', money: true }, createdAt: { label: 'Criada em' }, costSnapshot: { label: 'Custo registrado' }, payments: { label: 'Recebimentos' },
  catalogRef: { label: 'Medidas de referência' }, cupSizeMl: { label: 'Tamanho da xícara (ml)' }, businessName: { label: 'Nome do negócio' }, businessPhone: { label: 'Telefone' }, dailyCapacityMinutes: { label: 'Minutos por dia' }, workWeekdays: { label: 'Dias de trabalho' },
};

type ItemLike = { recipeName?: string; recipeId?: string; quantity?: number; unitPrice?: number };
/** Itens de encomenda: "50 × Brigadeiro (R$ 2,50)". */
const showOrderItems = (v: unknown): string => !Array.isArray(v) || !v.length ? 'Nenhum produto'
  : (v as ItemLike[]).map(i => `${(i.quantity ?? 0).toLocaleString('pt-BR')} × ${i.recipeName ?? 'Receita'}${i.unitPrice !== undefined ? ` (${brl(i.unitPrice)})` : ''}`).join('; ');
const show = (key: string, v: unknown, packagings: Packaging[] = []): string => {
  if (key === 'packagingItems') {
    if (v === undefined || v === null) return 'Registro legado sem informação de embalagens';
    if (!Array.isArray(v) || v.length === 0) return 'Nenhuma embalagem';
    return (v as { packagingId?: string; name?: string; quantityPerUnit?: number; quantity?: number; unitCost?: number }[]).map(item => {
      const packaging = packagings.find(p => p.id === item.packagingId);
      const name = item.name || packaging?.name || 'Embalagem';
      const quantity = item.quantityPerUnit ?? item.quantity;
      const unit = item.quantityPerUnit !== undefined ? 'por unidade' : 'utilizada';
      const cost = item.unitCost !== undefined ? ` · ${brl(item.unitCost)} cada` : '';
      return `${name}${quantity !== undefined ? ` · ${quantity} ${unit}` : ''}${cost}`;
    }).join('; ');
  }
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'number') return FIELD[key]?.money ? brl(v) : v.toLocaleString('pt-BR');
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split('-').reverse().join('/') : v;
  if (Array.isArray(v)) {
    if (key === 'payments') return v.length ? (v as { amount: number }[]).map(p => brl(p.amount)).join(' + ') : 'nenhum';
    if (key === 'items') return `${v.length} ${v.length === 1 ? 'item' : 'itens'}`;
    return v.join(', ');
  }
  if (typeof v === 'object' && key === 'catalogRef') { const r = v as { id: string; variant: string }; const item = findItem(r.id); return item ? `${item.name}${item.variants.length > 1 ? ` · ${findVariant(item, r.variant).label}` : ''}` : r.id; }
  if (typeof v === 'object') return key === 'costSnapshot' ? brl((v as { costPerUnit: number }).costPerUnit) : JSON.stringify(v);
  return String(v);
};

export type FieldRow = { key: string; label: string; local: string; server: string; base: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Campos em que a versão daqui e a da nuvem diferem (com a base, quando conhecida). Exclusão aparece como "Excluído". */
export function diffRows(c: ConflictRecord, packagings: Packaging[] = []): FieldRow[] {
  const L = c.local as Record<string, unknown> | null, S = c.server as Record<string, unknown> | null, B = c.base as Record<string, unknown> | null | undefined;
  if (!L || !S) return [{ key: '_', label: 'Registro', local: L ? 'Mantido' : 'Excluído', server: S ? 'Mantido' : 'Excluído', base: B ? 'Existia' : '—' }];
  const keys = [...new Set([...Object.keys(L), ...Object.keys(S)])].filter(k => k !== 'id' && !same(L[k], S[k]));
  return keys.map(k => {
    if (c.kind === 'orders' && k === 'items') return { key: k, label: 'Produtos da encomenda', local: showOrderItems(L[k]), server: showOrderItems(S[k]), base: B ? showOrderItems(B[k]) : '—' };
    return { key: k, label: FIELD[k]?.label ?? k, local: show(k, L[k], packagings), server: show(k, S[k], packagings), base: B ? show(k, B[k], packagings) : '—' };
  });
}

export const conflictName = (c: ConflictRecord): string => {
  const e = (c.local ?? c.server ?? c.base) as { name?: string; customer?: string } | null;
  return e?.name ?? e?.customer ?? KIND_LABEL[c.kind];
};
export const conflictTitle = (c: ConflictRecord): string => `${KIND_LABEL[c.kind][0].toUpperCase()}${KIND_LABEL[c.kind].slice(1)} “${conflictName(c)}”`;
