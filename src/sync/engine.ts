/**
 * Motor de sincronização do app (funções puras; a rede entra por `SyncApi`).
 *
 * Modelo: o servidor é a fonte autoritativa quando há conta + licença; o IndexedDB é cache offline + alterações pendentes.
 * `meta.baseline` é o último estado do servidor que este dispositivo conhece; "alterações locais" = local − baseline.
 * Ciclo: puxar e mesclar (3 vias) → enviar o que é só local (atômico, em blocos) → puxar de novo para fixar as revisões.
 * Conflito (mesma entidade alterada aqui e em outro dispositivo): o servidor vence, e a versão local perdida é GUARDADA em
 * `meta.conflicts` (nunca descartada em silêncio). Exclusões no servidor são lógicas; se algo novo aqui ainda depende de um
 * item excluído lá, o item é restaurado em vez de deixar referência quebrada.
 */
import { emptyPush, KINDS, SYNC_LIMITS, sameEntity, type Kind, type PullResponse, type PushRequest, type RevMap } from '../../shared/sync';
import type { DataSet, Ingredient, Order, Recipe } from '../domain/types';
import { CURRENT_SCHEMA_VERSION } from '../domain/types';

type Entity = Ingredient | Recipe | Order;
type KindMaps = { ingredients: Map<string, Ingredient>; recipes: Map<string, Recipe>; orders: Map<string, Order> };

export type ConflictRecord = { id: string; kind: Kind | 'settings'; entityId: string; at: string; reason: 'edited-elsewhere' | 'deleted-elsewhere' | 'restored'; local: unknown | null; server: unknown | null };
export type SyncMeta = {
  /** Revisão do servidor refletida no baseline. */
  revision: number;
  /** Revisão de cada entidade quando foi sincronizada (guarda também a revisão da exclusão lógica). */
  revs: { ingredients: RevMap; recipes: RevMap; orders: RevMap; settings?: number };
  baseline: DataSet;
  /** Alterações locais que o servidor substituiu. Ficam aqui até o usuário dispensar. */
  conflicts: ConflictRecord[];
  /** Conta a que estes dados pertencem. Impede misturar dados de contas diferentes no mesmo dispositivo. */
  userId?: string;
};
export const emptyDataSet = (): DataSet => ({ schemaVersion: CURRENT_SCHEMA_VERSION, ingredients: [], recipes: [], orders: [] });
export const emptyMeta = (): SyncMeta => ({ revision: 0, revs: { ingredients: {}, recipes: {}, orders: {} }, baseline: emptyDataSet(), conflicts: [] });

export type PushResponse = { ok: true; revision: number; changed: boolean } | { ok: false; kind: 'conflict' | 'stale' };
export interface SyncApi {
  pull(since: number): Promise<PullResponse>;
  push(request: PushRequest): Promise<PushResponse>;
}
/** Erros de rede/autorização/servidor que interrompem a sincronização sem alterar nenhum dado local. */
export class SyncError extends Error {
  constructor(readonly kind: 'offline' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'rejected' | 'server', message: string) { super(message); }
}

const toMaps = (d: DataSet): KindMaps => ({ ingredients: new Map(d.ingredients.map(x => [x.id, x])), recipes: new Map(d.recipes.map(x => [x.id, x])), orders: new Map(d.orders.map(x => [x.id, x])) });
const fromMaps = (like: DataSet, m: KindMaps): DataSet => {
  // Mantém a ordem local das entidades existentes e acrescenta as novas no fim.
  const order = <T extends { id: string }>(prev: T[], map: Map<string, T>): T[] => { const out = prev.filter(p => map.has(p.id)).map(p => map.get(p.id) as T); for (const [id, v] of map) if (!prev.some(p => p.id === id)) out.push(v); return out; };
  return { ...like, ingredients: order(like.ingredients, m.ingredients), recipes: order(like.recipes, m.recipes), orders: order(like.orders, m.orders) };
};
const sameOpt = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : sameEntity(a, b));
const clone = <T,>(v: T): T => structuredClone(v);

/** Referências quebradas (receita → ingrediente, encomenda → receita). Vazio = íntegro. */
export function findDanglingRefs(d: DataSet): string[] {
  const ing = new Set(d.ingredients.map(i => i.id)), rec = new Set(d.recipes.map(r => r.id));
  const out: string[] = [];
  for (const r of d.recipes) if (r.items.some(i => !ing.has(i.ingredientId))) out.push(`A receita "${r.name}" usa um ingrediente que não existe mais.`);
  for (const o of d.orders) if (!rec.has(o.recipeId)) out.push(`A encomenda de "${o.customer}" usa uma receita que não existe mais.`);
  return out;
}

/** Mescla (3 vias) as alterações do servidor no estado local. O servidor vence em conflitos, que são registrados. */
export function applyPull(local: DataSet, meta: SyncMeta, pull: PullResponse, now: Date = new Date()): { local: DataSet; meta: SyncMeta; conflicts: ConflictRecord[] } {
  const L = toMaps(local), B = toMaps(meta.baseline), revs = clone(meta.revs), conflicts: ConflictRecord[] = [];
  const at = now.toISOString();
  const removed = { ingredients: new Map<string, Ingredient>(), recipes: new Map<string, Recipe>() };

  for (const kind of KINDS) {
    const Lk = L[kind] as Map<string, Entity>, Bk = B[kind] as Map<string, Entity>;
    for (const ent of pull[kind] as { id: string; rev: number; deleted: boolean; data?: Entity }[]) {
      const lo = Lk.get(ent.id), ba = Bk.get(ent.id), server = ent.deleted ? undefined : ent.data;
      if (!sameOpt(lo, server)) {
        if (sameOpt(lo, ba)) { // sem alteração local: aceita o servidor
          if (server) Lk.set(ent.id, server); else { Lk.delete(ent.id); if (kind !== 'orders' && lo) (removed[kind] as Map<string, Entity>).set(ent.id, lo); }
        } else { // alterado aqui E no servidor: o servidor vence e a versão local fica guardada
          conflicts.push({ id: `${kind}:${ent.id}:${ent.rev}`, kind, entityId: ent.id, at, reason: server ? 'edited-elsewhere' : 'deleted-elsewhere', local: lo ?? null, server: server ?? null });
          if (server) Lk.set(ent.id, server); else { Lk.delete(ent.id); if (kind !== 'orders' && lo) (removed[kind] as Map<string, Entity>).set(ent.id, lo); }
        }
      }
      if (server) Bk.set(ent.id, server); else Bk.delete(ent.id);
      (revs[kind] as RevMap)[ent.id] = ent.rev;
    }
  }

  // Algo novo aqui ainda depende de um item que o servidor excluiu? Restaura o item (será reenviado) em vez de quebrar a referência.
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const o of L.orders.values()) if (!L.recipes.has(o.recipeId) && removed.recipes.has(o.recipeId)) { const r = removed.recipes.get(o.recipeId) as Recipe; L.recipes.set(r.id, r); conflicts.push({ id: `recipes:${r.id}:restored`, kind: 'recipes', entityId: r.id, at, reason: 'restored', local: r, server: null }); changed = true; }
    for (const r of L.recipes.values()) for (const it of r.items) if (!L.ingredients.has(it.ingredientId) && removed.ingredients.has(it.ingredientId)) { const i = removed.ingredients.get(it.ingredientId) as Ingredient; L.ingredients.set(i.id, i); conflicts.push({ id: `ingredients:${i.id}:restored`, kind: 'ingredients', entityId: i.id, at, reason: 'restored', local: i, server: null }); changed = true; }
    if (!changed) break;
  }

  let settings = local.settings, baselineSettings = meta.baseline.settings;
  if (pull.settings) {
    const srv = pull.settings.data;
    if (!sameOpt(settings, srv)) {
      if (!settings || sameOpt(settings, baselineSettings)) settings = srv;
      else { conflicts.push({ id: `settings:settings:${pull.settings.rev}`, kind: 'settings', entityId: 'settings', at, reason: 'edited-elsewhere', local: settings, server: srv }); settings = srv; }
    }
    baselineSettings = srv; revs.settings = pull.settings.rev;
  }

  const merged = { ...fromMaps(local, L), ...(settings ? { settings } : {}) };
  const baseline = { ...fromMaps(meta.baseline, B), ...(baselineSettings ? { settings: baselineSettings } : {}) };
  return { local: merged, meta: { revision: pull.revision, revs, baseline, conflicts: [...meta.conflicts, ...conflicts] }, conflicts };
}

/** Alterações que existem só aqui, divididas em envios de até 100 itens, na ordem das dependências. */
export function buildPushes(local: DataSet, meta: SyncMeta): PushRequest[] {
  const L = toMaps(local), B = toMaps(meta.baseline);
  type Op = { kind: Kind; id: string; apply: (p: PushRequest) => void };
  const upserts: Op[] = [], deletes: Op[] = [];
  for (const kind of KINDS) {
    const Lk = L[kind] as Map<string, Entity>, Bk = B[kind] as Map<string, Entity>;
    for (const [id, e] of Lk) if (!sameOpt(e, Bk.get(id))) upserts.push({ kind, id, apply: p => { (p.upserts[kind] as Entity[]).push(e); if (revOf(meta, kind, id) !== undefined) p.baseRevs[kind][id] = revOf(meta, kind, id) as number; } });
    for (const id of Bk.keys()) if (!Lk.has(id)) deletes.push({ kind, id, apply: p => { p.deletes[kind].push(id); p.baseRevs[kind][id] = revOf(meta, kind, id) ?? 0; } });
  }
  const rank = (k: Kind, del: boolean) => (del ? { orders: 0, recipes: 1, ingredients: 2 }[k] : { ingredients: 0, recipes: 1, orders: 2 }[k]);
  const ops = [...upserts.sort((a, b) => rank(a.kind, false) - rank(b.kind, false)), ...deletes.sort((a, b) => rank(a.kind, true) - rank(b.kind, true))];
  const pushes: PushRequest[] = [];
  let current = emptyPush(meta.revision), count = 0;
  if (local.settings && !sameOpt(local.settings, meta.baseline.settings)) { current.upserts.settings = local.settings; current.baseRevs.settings = meta.revs.settings ?? 0; count++; }
  for (const op of ops) {
    if (count >= SYNC_LIMITS.maxChangesPerPush) { pushes.push(current); current = emptyPush(meta.revision); count = 0; }
    op.apply(current); count++;
  }
  if (count > 0) pushes.push(current);
  return pushes;
}
const revOf = (meta: SyncMeta, kind: Kind, id: string): number | undefined => meta.revs[kind][id];

export type SyncStatus = 'synced' | 'offline' | 'unauthorized' | 'needs-attention' | 'needs-decision' | 'error';
export type SyncResult = { status: SyncStatus; message?: string; local: DataSet; meta: SyncMeta; pulled: number; pushed: number; newConflicts: ConflictRecord[] };

const isEmpty = (d: DataSet) => !d.ingredients.length && !d.recipes.length && !d.orders.length;
/** O servidor tem algo que NÃO é idêntico ao que existe aqui (item ausente, diferente ou excluído lá)? */
function hasForeignData(local: DataSet, pull: PullResponse): boolean {
  const L = toMaps(local);
  return KINDS.some(kind => (pull[kind] as { id: string; deleted: boolean; data?: Entity }[]).some(e => (e.deleted ? L[kind].has(e.id) : !sameOpt(L[kind].get(e.id), e.data))));
}
const pulledCount = (p: PullResponse) => p.ingredients.length + p.recipes.length + p.orders.length;

/**
 * Um ciclo de sincronização. Não altera os argumentos; devolve o novo estado.
 * Falhas de rede/autorização interrompem sem perder nada: o estado devolvido é o último consistente.
 * Reexecutar após uma falha é seguro (o servidor trata reenvios idênticos como "sem alteração").
 */
export async function syncOnce(api: SyncApi, local: DataSet, meta: SyncMeta, opts: { allowInitialMerge?: boolean; now?: Date } = {}): Promise<SyncResult> {
  let L = local, M = meta, pulled = 0, pushed = 0;
  const newConflicts: ConflictRecord[] = [];
  const result = (status: SyncStatus, message?: string): SyncResult => ({ status, message, local: L, meta: M, pulled, pushed, newConflicts });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const pull = await api.pull(M.revision);
      // Primeira sincronização com dados dos dois lados: só pede decisão se o servidor tiver algo diferente do local
      // (um reenvio depois de uma resposta perdida encontra tudo idêntico e segue sozinho).
      if (attempt === 0 && M.revision === 0 && isEmpty(M.baseline) && !isEmpty(L) && pulledCount(pull) > 0 && !opts.allowInitialMerge && hasForeignData(L, pull)) return result('needs-decision', 'Há dados neste dispositivo e na conta. Escolha como combinar.');
      pulled += pulledCount(pull);
      const merged = applyPull(L, M, pull, opts.now);
      L = merged.local; M = merged.meta; newConflicts.push(...merged.conflicts);
      const dangling = findDanglingRefs(L);
      if (dangling.length) return result('needs-attention', dangling[0]);
      const pushes = buildPushes(L, M);
      if (!pushes.length) return result('synced');
      let again = false;
      let revision = M.revision;
      for (const req of pushes) {
        const resp = await api.push({ ...req, baseRevision: revision });
        if (!resp.ok) { again = true; break; } // mudou no servidor: puxa de novo, mescla e tenta outra vez
        revision = resp.revision; pushed += countOf(req);
      }
      if (!again && attempt === 3) return result('error', 'Não foi possível concluir a sincronização. Tente novamente.');
    }
    return result('error', 'Não foi possível concluir a sincronização. Tente novamente.');
  } catch (e) {
    if (e instanceof SyncError) return result(e.kind === 'offline' ? 'offline' : e.kind === 'unauthorized' ? 'unauthorized' : e.kind === 'rejected' ? 'needs-attention' : 'error', e.message);
    throw e;
  }
}
const countOf = (p: PushRequest) => KINDS.reduce((n, k) => n + p.upserts[k].length + p.deletes[k].length, p.upserts.settings ? 1 : 0);

/**
 * Aplica o resultado de uma sincronização ao estado ATUAL (o usuário pode ter editado enquanto a rede trabalhava):
 * onde nada mudou desde o início da sincronização, vale o resultado; onde o usuário editou, vale a edição dele.
 */
export function rebaseLocal(current: DataSet, startedFrom: DataSet, synced: DataSet): DataSet {
  const C = toMaps(current), S = toMaps(startedFrom), R = toMaps(synced);
  for (const kind of KINDS) {
    const Ck = C[kind] as Map<string, Entity>, Sk = S[kind] as Map<string, Entity>, Rk = R[kind] as Map<string, Entity>;
    const ids = new Set([...Ck.keys(), ...Sk.keys(), ...Rk.keys()]);
    for (const id of ids) {
      if (!sameOpt(Ck.get(id), Sk.get(id))) continue; // editado durante a sincronização: mantém a edição
      const r = Rk.get(id);
      if (r) Ck.set(id, r); else Ck.delete(id);
    }
  }
  const settings = sameOpt(current.settings, startedFrom.settings) ? synced.settings : current.settings;
  return { ...fromMaps(current, C), ...(settings ? { settings } : {}) };
}
