/**
 * Contrato da sincronização entre o app e o servidor (usado dos dois lados).
 * Cada gravação aceita no servidor incrementa a `revision` da conta; cada entidade guarda a revisão em que mudou (`rev`).
 * O envio (push) só vale se nenhuma das entidades enviadas mudou no servidor depois da revisão que o cliente conhecia.
 */
import type { Ingredient, Order, Packaging, Recipe, Settings } from '../src/domain/types';

export const SYNC_LIMITS = { maxChangesPerPush: 100, maxBodyBytes: 1_000_000 } as const;
export const KINDS = ['ingredients', 'recipes', 'orders', 'packagings'] as const;
export type Kind = (typeof KINDS)[number];
export type RevMap = Record<string, number>;

export type PushRequest = {
  /** Revisão da conta que o cliente tinha ao começar. */
  baseRevision: number;
  /** Revisão conhecida de cada entidade alterada (ausente = o cliente a considera nova). */
  baseRevs: { ingredients: RevMap; recipes: RevMap; orders: RevMap; packagings: RevMap; settings?: number };
  upserts: { ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[]; packagings: Packaging[]; settings?: Settings };
  /** Exclusões lógicas (o servidor mantém um registro; nada é apagado de verdade). */
  deletes: { ingredients: string[]; recipes: string[]; orders: string[]; packagings: string[] };
};
export type PullEntity<T> = { id: string; rev: number; deleted: boolean; data?: T };
export type PullResponse = {
  revision: number;
  ingredients: PullEntity<Ingredient>[];
  recipes: PullEntity<Recipe>[];
  orders: PullEntity<Order>[];
  packagings?: PullEntity<Packaging>[];
  settings?: { rev: number; data: Settings };
};
export type Conflict = { kind: Kind | 'settings'; id: string; serverRev: number };
export type PushOk = { revision: number; changed: boolean };
export type PushError =
  | { error: 'CONFLICT'; conflicts: Conflict[]; revision: number }
  | { error: 'STALE'; revision: number }
  /** Algum código de orçamento já existe em outra encomenda da conta: o app troca o código das encomendas indicadas e reenvia. */
  | { error: 'CODE_TAKEN'; orderIds: string[]; revision: number }
  | { error: 'REFERENCE_ERROR' | 'INVALID_PAYLOAD' | 'TOO_MANY_CHANGES'; message: string };

export const emptyPush = (baseRevision: number): PushRequest => ({ baseRevision, baseRevs: { ingredients: {}, recipes: {}, orders: {}, packagings: {} }, upserts: { ingredients: [], recipes: [], orders: [], packagings: [] }, deletes: { ingredients: [], recipes: [], orders: [], packagings: [] } });
export const countChanges = (p: PushRequest) => KINDS.reduce((n, k) => n + (p.upserts[k]?.length ?? 0) + (p.deletes[k]?.length ?? 0), p.upserts.settings ? 1 : 0);

/** JSON canônico (chaves ordenadas): permite comparar entidades sem depender da ordem dos campos. */
export const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** Ausência e zero significam a mesma cobrança para pedidos legados que antecedem `packagingCharge`. */
function canonicalEntityValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  // Registros antigos não tinham esta propriedade; nulo e lista vazia também significam
  // que nenhuma embalagem foi associada. Uma lista com itens continua sendo comparada
  // por conteúdo, mas sua ordem de apresentação não cria um conflito artificial.
  if (record.items && Array.isArray(record.items) && 'yield' in record && 'packagingPerUnit' in record) {
    if (record.packagingItems == null || (Array.isArray(record.packagingItems) && record.packagingItems.length === 0)) delete record.packagingItems;
    else if (Array.isArray(record.packagingItems)) record.packagingItems = [...record.packagingItems].sort((a, b) => { const left = canonicalJson(a), right = canonicalJson(b); return left < right ? -1 : left > right ? 1 : 0; });
  }
  if (record.packagingCharge === 0) delete record.packagingCharge;
  return record;
}
export const sameEntity = (a: unknown, b: unknown): boolean => canonicalJson(canonicalEntityValue(a)) === canonicalJson(canonicalEntityValue(b));
