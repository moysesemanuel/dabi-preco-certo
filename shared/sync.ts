/**
 * Contrato da sincronização entre o app e o servidor (usado dos dois lados).
 * Cada gravação aceita no servidor incrementa a `revision` da conta; cada entidade guarda a revisão em que mudou (`rev`).
 * O envio (push) só vale se nenhuma das entidades enviadas mudou no servidor depois da revisão que o cliente conhecia.
 */
import type { Ingredient, Order, Recipe, Settings } from '../src/domain/types';

export const SYNC_LIMITS = { maxChangesPerPush: 100, maxBodyBytes: 1_000_000 } as const;
export const KINDS = ['ingredients', 'recipes', 'orders'] as const;
export type Kind = (typeof KINDS)[number];
export type RevMap = Record<string, number>;

export type PushRequest = {
  /** Revisão da conta que o cliente tinha ao começar. */
  baseRevision: number;
  /** Revisão conhecida de cada entidade alterada (ausente = o cliente a considera nova). */
  baseRevs: { ingredients: RevMap; recipes: RevMap; orders: RevMap; settings?: number };
  upserts: { ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[]; settings?: Settings };
  /** Exclusões lógicas (o servidor mantém um registro; nada é apagado de verdade). */
  deletes: { ingredients: string[]; recipes: string[]; orders: string[] };
};
export type PullEntity<T> = { id: string; rev: number; deleted: boolean; data?: T };
export type PullResponse = {
  revision: number;
  ingredients: PullEntity<Ingredient>[];
  recipes: PullEntity<Recipe>[];
  orders: PullEntity<Order>[];
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

export const emptyPush = (baseRevision: number): PushRequest => ({ baseRevision, baseRevs: { ingredients: {}, recipes: {}, orders: {} }, upserts: { ingredients: [], recipes: [], orders: [] }, deletes: { ingredients: [], recipes: [], orders: [] } });
export const countChanges = (p: PushRequest) => KINDS.reduce((n, k) => n + p.upserts[k].length + p.deletes[k].length, p.upserts.settings ? 1 : 0);

/** JSON canônico (chaves ordenadas): permite comparar entidades sem depender da ordem dos campos. */
export const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const sameEntity = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
