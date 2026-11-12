/** Textos em português para mostrar um conflito: nome da entidade, campos que divergem e valores formatados. */
import type { ConflictRecord } from './engine';

export const KIND_LABEL: Record<ConflictRecord['kind'], string> = { ingredients: 'ingrediente', recipes: 'receita', orders: 'encomenda', settings: 'configurações' };
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FIELD: Record<string, { label: string; money?: boolean }> = {
  name: { label: 'Nome' }, unit: { label: 'Unidade' }, purchaseQuantity: { label: 'Quantidade comprada' }, purchasePrice: { label: 'Preço', money: true },
  densityGPerMl: { label: 'Densidade (g/ml)' }, gramsPerUnit: { label: 'Gramas por unidade' },
  yield: { label: 'Rendimento' }, items: { label: 'Ingredientes da receita' }, packagingPerUnit: { label: 'Embalagem por unidade', money: true }, laborTotal: { label: 'Mão de obra', money: true },
  extraTotal: { label: 'Custos extras', money: true }, desiredMargin: { label: 'Margem desejada (%)' }, prepMinutes: { label: 'Minutos de preparo' },
  customer: { label: 'Cliente' }, recipeId: { label: 'Receita' }, quantity: { label: 'Quantidade' }, unitPrice: { label: 'Preço unitário', money: true }, deliveryDate: { label: 'Entrega' },
  status: { label: 'Situação' }, deposit: { label: 'Sinal', money: true }, createdAt: { label: 'Criada em' }, costSnapshot: { label: 'Custo registrado' }, payments: { label: 'Recebimentos' },
  cupSizeMl: { label: 'Tamanho da xícara (ml)' }, businessName: { label: 'Nome do negócio' }, businessPhone: { label: 'Telefone' }, dailyCapacityMinutes: { label: 'Minutos por dia' }, workWeekdays: { label: 'Dias de trabalho' },
};

const show = (key: string, v: unknown): string => {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'number') return FIELD[key]?.money ? brl(v) : v.toLocaleString('pt-BR');
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split('-').reverse().join('/') : v;
  if (Array.isArray(v)) {
    if (key === 'payments') return v.length ? (v as { amount: number }[]).map(p => brl(p.amount)).join(' + ') : 'nenhum';
    if (key === 'items') return `${v.length} ${v.length === 1 ? 'item' : 'itens'}`;
    return v.join(', ');
  }
  if (typeof v === 'object') return key === 'costSnapshot' ? brl((v as { costPerUnit: number }).costPerUnit) : JSON.stringify(v);
  return String(v);
};

export type FieldRow = { key: string; label: string; local: string; server: string; base: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Campos em que a versão daqui e a da nuvem diferem (com a base, quando conhecida). Exclusão aparece como "Excluído". */
export function diffRows(c: ConflictRecord): FieldRow[] {
  const L = c.local as Record<string, unknown> | null, S = c.server as Record<string, unknown> | null, B = c.base as Record<string, unknown> | null | undefined;
  if (!L || !S) return [{ key: '_', label: 'Registro', local: L ? 'Mantido' : 'Excluído', server: S ? 'Mantido' : 'Excluído', base: B ? 'Existia' : '—' }];
  const keys = [...new Set([...Object.keys(L), ...Object.keys(S)])].filter(k => k !== 'id' && !same(L[k], S[k]));
  return keys.map(k => ({ key: k, label: FIELD[k]?.label ?? k, local: show(k, L[k]), server: show(k, S[k]), base: B ? show(k, B[k]) : '—' }));
}

export const conflictName = (c: ConflictRecord): string => {
  const e = (c.local ?? c.server ?? c.base) as { name?: string; customer?: string } | null;
  return e?.name ?? e?.customer ?? KIND_LABEL[c.kind];
};
export const conflictTitle = (c: ConflictRecord): string => `${KIND_LABEL[c.kind][0].toUpperCase()}${KIND_LABEL[c.kind].slice(1)} “${conflictName(c)}”`;
