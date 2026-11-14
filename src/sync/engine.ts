/**
 * Motor de sincronização do app (funções puras; a rede entra por `SyncApi`).
 *
 * Modelo: o servidor é a fonte autoritativa quando há conta + licença; o IndexedDB é cache offline + alterações pendentes.
 * `meta.baseline` é o último estado do servidor que este dispositivo conhece; "alterações locais" = local − baseline.
 * Ciclo: puxar e mesclar (3 vias) → enviar o que é só local (atômico, em blocos) → puxar de novo para fixar as revisões.
 * Conflito (mesma entidade alterada aqui e em outro dispositivo, a partir da mesma base): NADA é sobrescrito. A versão local continua
 * nos dados, a versão da nuvem e a base ficam em `meta.conflicts` (persistido no IndexedDB), o envio dessa entidade é retido e o
 * usuário decide (`resolveConflict`). Exceção: dinheiro de encomendas segue a reconciliação financeira explícita (`reconcile.ts`).
 * Exclusões no servidor são lógicas; se algo novo aqui ainda depende de um item excluído lá, o item é restaurado em vez de deixar
 * referência quebrada.
 */
import { uniqueQuoteCode } from '../../shared/quoteCode';
import { emptyPush, KINDS, SYNC_LIMITS, sameEntity, type Kind, type PullResponse, type PushRequest, type RevMap } from '../../shared/sync';
import type { DataSet, Ingredient, Order, Packaging, Payment, Recipe } from '../domain/types';
import { CURRENT_SCHEMA_VERSION } from '../domain/types';

type Entity = Ingredient | Recipe | Order | Packaging;
type KindMaps = { ingredients: Map<string, Ingredient>; recipes: Map<string, Recipe>; orders: Map<string, Order>; packagings: Map<string, Packaging> };

/** O que este dispositivo fez com o DINHEIRO de uma encomenda e o servidor não tem. Exige reconciliação explícita. */
export type FinancialDiff = { addedPayments: Payment[]; removedPayments: Payment[]; deposit?: { local: number; server: number | null } };
export type ConflictRecord = { id: string; kind: Kind | 'settings'; entityId: string; at: string; reason: 'edited-elsewhere' | 'deleted-elsewhere' | 'restored'; local: unknown | null; server: unknown | null;
  /** true = aguarda decisão do usuário: a versão local segue nos dados, o envio é retido e a nuvem NÃO foi aplicada. */
  pending?: boolean;
  /** Versão-base (último estado comum aos dois lados); null = a entidade não existia na base. */
  base?: unknown | null;
  /** Revisão da versão da nuvem guardada em `server` (usada como base ao enviar a versão local). */
  serverRev?: number;
  /** Última vez que a versão da nuvem mudou enquanto o conflito esperava. */
  updatedAt?: string;
  /** Só em encomendas: recebimentos/sinal alterados aqui e não refletidos no servidor. Nunca é descartado sem escolha do usuário. */
  financial?: FinancialDiff;
  /** Preenchido quando o usuário resolveu a pendência financeira. */
  resolution?: { action: 'merge' | 'keep-server' | 'keep-local' | 'identical'; at: string } };
/** Pendência financeira ainda sem decisão do usuário. */
export const isOpenFinancial = (c: ConflictRecord): boolean => !!c.financial && !c.resolution;
/** Conflito aguardando decisão (comparação local × nuvem). */
export const isPendingConflict = (c: ConflictRecord): boolean => c.pending === true && !c.resolution;
/** Qualquer pendência que impede dizer "sincronizado": conflito de dados ou dinheiro sem decisão. */
export const isUnresolved = (c: ConflictRecord): boolean => isPendingConflict(c) || isOpenFinancial(c);

/**
 * Diferença financeira que ESTE dispositivo criou em relação ao baseline e que o servidor não tem:
 * recebimentos lançados aqui, recebimentos removidos aqui (e ainda existentes no servidor) e mudança do sinal.
 * Vazio (undefined) quando a perda de uma versão local não envolve dinheiro (ex.: só mudou o nome do cliente).
 */
export function financialDiff(local: Order, baseline: Order | undefined, server: Order | undefined): FinancialDiff | undefined {
  const ids = (list?: Payment[]) => new Set((list ?? []).map(p => p.id));
  const baseIds = ids(baseline?.payments), serverIds = ids(server?.payments), localIds = ids(local.payments);
  const addedPayments = (local.payments ?? []).filter(p => !baseIds.has(p.id) && !serverIds.has(p.id));
  const removedPayments = (baseline?.payments ?? []).filter(p => !localIds.has(p.id) && serverIds.has(p.id));
  const depositChanged = local.deposit !== (baseline?.deposit ?? 0) && local.deposit !== (server?.deposit ?? 0);
  if (!addedPayments.length && !removedPayments.length && !depositChanged) return undefined;
  return { addedPayments, removedPayments, ...(depositChanged ? { deposit: { local: local.deposit, server: server?.deposit ?? null } } : {}) };
}
export type SyncMeta = {
  /** Revisão do servidor refletida no baseline. */
  revision: number;
  /** Revisão de cada entidade quando foi sincronizada (guarda também a revisão da exclusão lógica). */
  revs: { ingredients: RevMap; recipes: RevMap; orders: RevMap; packagings: RevMap; settings?: number };
  baseline: DataSet;
  /** Alterações locais que o servidor substituiu. Ficam aqui até o usuário dispensar. */
  conflicts: ConflictRecord[];
  /** Conta a que estes dados pertencem. Impede misturar dados de contas diferentes no mesmo dispositivo. */
  userId?: string;
};
export const emptyDataSet = (): DataSet => ({ schemaVersion: CURRENT_SCHEMA_VERSION, ingredients: [], recipes: [], orders: [], packagings: [] });
export const emptyMeta = (): SyncMeta => ({ revision: 0, revs: { ingredients: {}, recipes: {}, orders: {}, packagings: {} }, baseline: emptyDataSet(), conflicts: [] });

export type PushResponse = { ok: true; revision: number; changed: boolean } | { ok: false; kind: 'conflict' | 'stale' } | { ok: false; kind: 'code'; orderIds: string[] };
export interface SyncApi {
  pull(since: number): Promise<PullResponse>;
  push(request: PushRequest): Promise<PushResponse>;
}
/** Erros de rede/autorização/servidor que interrompem a sincronização sem alterar nenhum dado local. */
export class SyncError extends Error {
  constructor(readonly kind: 'offline' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'rejected' | 'server', message: string) { super(message); }
}

const toMaps = (d: DataSet): KindMaps => ({ ingredients: new Map(d.ingredients.map(x => [x.id, x])), recipes: new Map(d.recipes.map(x => [x.id, x])), orders: new Map(d.orders.map(x => [x.id, x])), packagings: new Map((d.packagings ?? []).map(x => [x.id, x])) });
const fromMaps = (like: DataSet, m: KindMaps): DataSet => {
  // Mantém a ordem local das entidades existentes e acrescenta as novas no fim.
  const order = <T extends { id: string }>(prev: T[], map: Map<string, T>): T[] => { const out = prev.filter(p => map.has(p.id)).map(p => map.get(p.id) as T); for (const [id, v] of map) if (!prev.some(p => p.id === id)) out.push(v); return out; };
  return { ...like, ingredients: order(like.ingredients, m.ingredients), recipes: order(like.recipes, m.recipes), orders: order(like.orders, m.orders), packagings: order(like.packagings ?? [], m.packagings) };
};
const sameOpt = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : sameEntity(a, b));
const clone = <T,>(v: T): T => structuredClone(v);
const withoutCode = (o: Order): Omit<Order, 'quoteCode'> => { const { quoteCode: _q, ...rest } = o; return rest; };
export const sameOptEntity = sameOpt;

/** Referências quebradas (receita → ingrediente, encomenda → receita). Vazio = íntegro. */
export function findDanglingRefs(d: DataSet): string[] {
  const ing = new Set(d.ingredients.map(i => i.id)), rec = new Set(d.recipes.map(r => r.id));
  const out: string[] = [];
  for (const r of d.recipes) if (r.items.some(i => !ing.has(i.ingredientId))) out.push(`A receita "${r.name}" usa um ingrediente que não existe mais.`);
  for (const o of d.orders) if (!rec.has(o.recipeId)) out.push(`A encomenda de "${o.customer}" usa uma receita que não existe mais.`);
  return out;
}

/** Mescla (3 vias) as alterações do servidor no estado local. Conflitos ficam pendentes (nada é sobrescrito) até o usuário decidir. */
export function applyPull(local: DataSet, meta: SyncMeta, pull: PullResponse, now: Date = new Date()): { local: DataSet; meta: SyncMeta; conflicts: ConflictRecord[] } {
  const L = toMaps(local), B = toMaps(meta.baseline), revs = clone(meta.revs), conflicts: ConflictRecord[] = [];
  const all: ConflictRecord[] = meta.conflicts.map(c => ({ ...c }));
  const at = now.toISOString();
  const removed = { ingredients: new Map<string, Ingredient>(), recipes: new Map<string, Recipe>(), packagings: new Map<string, Packaging>() };
  const pendingFor = (kind: ConflictRecord['kind'], id: string) => all.find(c => isPendingConflict(c) && c.kind === kind && c.entityId === id);

  for (const kind of KINDS) {
    const Lk = L[kind] as Map<string, Entity>, Bk = B[kind] as Map<string, Entity>;
    for (const ent of (pull[kind] ?? []) as { id: string; rev: number; deleted: boolean; data?: Entity }[]) {
      let lo = Lk.get(ent.id);
      const ba = Bk.get(ent.id), server = ent.deleted ? undefined : ent.data;
      if (kind === 'orders' && lo && server && !pendingFor(kind, ent.id)) {
        // O código de atendimento é um campo de sistema, permanente e decidido pelo servidor: nunca gera conflito.
        const sc = (server as Order).quoteCode, lc = (lo as Order).quoteCode;
        const sameBeyondCode = ba !== undefined && sameOpt(withoutCode(lo as Order), withoutCode(ba as Order));
        if (sameBeyondCode) { // aqui só pode ter mudado o código: vale a versão do servidor (mantendo o código local se o servidor ainda não tem um)
          Lk.set(ent.id, sc || !lc ? server : { ...(server as Order), quoteCode: lc });
          Bk.set(ent.id, server); (revs[kind] as RevMap)[ent.id] = ent.rev; continue;
        }
        if (sc && lc !== sc) { lo = { ...(lo as Order), quoteCode: sc }; Lk.set(ent.id, lo); }
      }
      const pend = pendingFor(kind, ent.id);
      if (pend) {
        // Já há um conflito aguardando decisão: só atualizamos a versão da nuvem. Nada local é tocado e a base é preservada.
        if (sameOpt(lo, server)) { pend.pending = false; pend.resolution = { action: 'identical', at }; if (server) Bk.set(ent.id, server); else Bk.delete(ent.id); (revs[kind] as RevMap)[ent.id] = ent.rev; }
        else { pend.server = server ?? null; pend.serverRev = ent.rev; pend.updatedAt = at; pend.reason = server ? 'edited-elsewhere' : 'deleted-elsewhere'; }
        continue;
      }
      if (!sameOpt(lo, server)) {
        if (sameOpt(lo, ba)) { // sem alteração local: aceita o servidor
          if (server) Lk.set(ent.id, server); else { Lk.delete(ent.id); if (kind !== 'orders' && lo) (removed[kind] as Map<string, Entity>).set(ent.id, lo); }
        } else if (sameOpt(server, ba)) { // o servidor continua na base: só houve edição local
          // Preserva a edição e confirma a revisão/base que o servidor acabou de devolver.
        } else {
          const financial = kind === 'orders' && lo ? financialDiff(lo as Order, ba as Order | undefined, server as Order | undefined) : undefined;
          if (financial) { // dinheiro mexido aqui e lá: reconciliação financeira explícita (o servidor é aplicado e o que foi lançado aqui fica pendente)
            conflicts.push({ id: `${kind}:${ent.id}:${ent.rev}`, kind, entityId: ent.id, at, reason: server ? 'edited-elsewhere' : 'deleted-elsewhere', local: lo ?? null, server: server ?? null, financial });
            if (server) Lk.set(ent.id, server); else Lk.delete(ent.id);
          } else { // alterado aqui E no servidor: preserva as duas versões e a base; a decisão é do usuário
            conflicts.push({ id: `${kind}:${ent.id}:${ent.rev}`, kind, entityId: ent.id, at, reason: server ? 'edited-elsewhere' : 'deleted-elsewhere', local: lo ?? null, server: server ?? null, base: ba ?? null, serverRev: ent.rev, pending: true });
            all.push(conflicts[conflicts.length - 1]);
            continue; // não altera local, base nem revisão desta entidade
          }
        }
      }
      if (server) Bk.set(ent.id, server); else Bk.delete(ent.id);
      (revs[kind] as RevMap)[ent.id] = ent.rev;
    }
  }

  // Algo novo aqui ainda depende de um item que o servidor excluiu? Restaura o item (será reenviado) em vez de quebrar a referência.
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const o of L.orders.values()) if (!L.recipes.has(o.recipeId) && removed.recipes.has(o.recipeId)) { const r = removed.recipes.get(o.recipeId) as Recipe; L.recipes.set(r.id, r); conflicts.push({ id: `recipes:${r.id}:restored`, kind: 'recipes', entityId: r.id, at, reason: 'restored', local: r, server: null }); changed = true; }
    for (const r of L.recipes.values()) for (const it of r.items) if (!L.ingredients.has(it.ingredientId) && removed.ingredients.has(it.ingredientId)) { const i = removed.ingredients.get(it.ingredientId) as Ingredient; L.ingredients.set(i.id, i); conflicts.push({ id: `ingredients:${i.id}:restored`, kind: 'ingredients', entityId: i.id, at, reason: 'restored', local: i, server: null }); changed = true; }
    for (const r of L.recipes.values()) for (const it of r.packagingItems ?? []) if (!L.packagings.has(it.packagingId) && removed.packagings.has(it.packagingId)) { const p = removed.packagings.get(it.packagingId) as Packaging; L.packagings.set(p.id, p); conflicts.push({ id: `packagings:${p.id}:restored`, kind: 'packagings', entityId: p.id, at, reason: 'restored', local: p, server: null }); changed = true; }
    if (!changed) break;
  }

  let settings = local.settings, baselineSettings = meta.baseline.settings;
  if (pull.settings) {
    const srv = pull.settings.data, pend = pendingFor('settings', 'settings');
    if (pend) {
      if (sameOpt(settings, srv)) { pend.pending = false; pend.resolution = { action: 'identical', at }; baselineSettings = srv; revs.settings = pull.settings.rev; }
      else { pend.server = srv; pend.serverRev = pull.settings.rev; pend.updatedAt = at; }
    } else if (!sameOpt(settings, srv)) {
      if (!settings || sameOpt(settings, baselineSettings)) { settings = srv; baselineSettings = srv; revs.settings = pull.settings.rev; }
      else { const c: ConflictRecord = { id: `settings:settings:${pull.settings.rev}`, kind: 'settings', entityId: 'settings', at, reason: 'edited-elsewhere', local: settings, server: srv, base: baselineSettings ?? null, serverRev: pull.settings.rev, pending: true }; conflicts.push(c); all.push(c); }
    } else { baselineSettings = srv; revs.settings = pull.settings.rev; }
  }

  const merged = { ...fromMaps(local, L), ...(settings ? { settings } : {}) };
  const baseline = { ...fromMaps(meta.baseline, B), ...(baselineSettings ? { settings: baselineSettings } : {}) };
  // `all` já contém os conflitos novos que aguardam decisão; os demais (financeiros, restaurações) entram aqui.
  const extra = conflicts.filter(c => !all.includes(c));
  return { local: merged, meta: { revision: pull.revision, revs, baseline, conflicts: [...all, ...extra] }, conflicts };
}

/**
 * Autocorreção: um conflito pendente cuja versão local já é igual à da nuvem não tem mais divergência (por exemplo, a escolha foi
 * gravada nos dados, mas o aparelho fechou antes de gravar o estado de sincronização). Nada é perdido ao fechá-lo.
 */
export function healConflicts(local: DataSet, meta: SyncMeta, now: Date = new Date()): SyncMeta {
  const L = toMaps(local); let changed = false;
  const baseline = clone(meta.baseline), B = toMaps(baseline), revs = clone(meta.revs);
  const conflicts = meta.conflicts.map(c => {
    if (!isPendingConflict(c)) return c;
    const cur = c.kind === 'settings' ? local.settings : (L[c.kind] as Map<string, Entity>).get(c.entityId);
    if (!sameOpt(cur, c.server ?? undefined)) return c;
    changed = true;
    if (c.kind === 'settings') { if (c.server) baseline.settings = c.server as DataSet['settings']; if (c.serverRev !== undefined) revs.settings = c.serverRev; }
    else { const Bk = B[c.kind] as Map<string, Entity>; if (c.server) Bk.set(c.entityId, c.server as Entity); else Bk.delete(c.entityId); if (c.serverRev !== undefined) (revs[c.kind] as RevMap)[c.entityId] = c.serverRev; }
    return { ...c, pending: false, resolution: { action: 'identical' as const, at: now.toISOString() } };
  });
  if (!changed) return meta;
  return { ...meta, conflicts, revs, baseline: { ...fromMaps(baseline, B), ...(baseline.settings ? { settings: baseline.settings } : {}) } };
}

/** Alterações que existem só aqui, divididas em envios de até 100 itens, na ordem das dependências. */
export function buildPushes(local: DataSet, meta: SyncMeta): PushRequest[] {
  const L = toMaps(local), B = toMaps(meta.baseline);
  type Op = { kind: Kind; id: string; apply: (p: PushRequest) => void };
  const upserts: Op[] = [], deletes: Op[] = [];
  // Entidades com conflito aguardando decisão NUNCA são enviadas (enviar sobrescreveria a nuvem). Quem depende de algo que a nuvem excluiu também espera.
  const pend = meta.conflicts.filter(isPendingConflict);
  const held = (kind: Kind, id: string) => pend.some(c => c.kind === kind && c.entityId === id);
  const goneInCloud = (kind: Kind, id: string) => pend.some(c => c.kind === kind && c.entityId === id && c.server === null);
  const blocked = (kind: Kind, e: Entity) => held(kind, e.id)
    || (kind === 'recipes' && ((e as Recipe).items.some(it => goneInCloud('ingredients', it.ingredientId)) || ((e as Recipe).packagingItems ?? []).some(it => goneInCloud('packagings', it.packagingId))))
    || (kind === 'orders' && goneInCloud('recipes', (e as Order).recipeId));
  for (const kind of KINDS) {
    const Lk = L[kind] as Map<string, Entity>, Bk = B[kind] as Map<string, Entity>;
    for (const [id, e] of Lk) if (!blocked(kind, e) && !sameOpt(e, Bk.get(id))) upserts.push({ kind, id, apply: p => { (p.upserts[kind] as Entity[]).push(e); if (revOf(meta, kind, id) !== undefined) p.baseRevs[kind][id] = revOf(meta, kind, id) as number; } });
    for (const id of Bk.keys()) if (!Lk.has(id) && !held(kind, id)) deletes.push({ kind, id, apply: p => { p.deletes[kind].push(id); p.baseRevs[kind][id] = revOf(meta, kind, id) ?? 0; } });
  }
  const rank = (k: Kind, del: boolean) => (del ? { orders: 0, recipes: 1, ingredients: 2, packagings: 3 }[k] : { packagings: 0, ingredients: 1, recipes: 2, orders: 3 }[k]);
  const ops = [...upserts.sort((a, b) => rank(a.kind, false) - rank(b.kind, false)), ...deletes.sort((a, b) => rank(a.kind, true) - rank(b.kind, true))];
  const pushes: PushRequest[] = [];
  let current = emptyPush(meta.revision), count = 0;
  if (local.settings && !sameOpt(local.settings, meta.baseline.settings) && !pend.some(c => c.kind === 'settings')) { current.upserts.settings = local.settings; current.baseRevs.settings = meta.revs.settings ?? 0; count++; }
  for (const op of ops) {
    if (count >= SYNC_LIMITS.maxChangesPerPush) { pushes.push(current); current = emptyPush(meta.revision); count = 0; }
    op.apply(current); count++;
  }
  if (count > 0) pushes.push(current);
  return pushes;
}
const revOf = (meta: SyncMeta, kind: Kind, id: string): number | undefined => meta.revs[kind][id];

export type SyncStatus = 'synced' | 'offline' | 'unauthorized' | 'forbidden' | 'needs-attention' | 'needs-decision' | 'error';
export type SyncResult = { status: SyncStatus; message?: string; local: DataSet; meta: SyncMeta; pulled: number; pushed: number; newConflicts: ConflictRecord[] };

const isEmpty = (d: DataSet) => !d.ingredients.length && !d.recipes.length && !d.orders.length && !(d.packagings ?? []).length;
/** O servidor tem algo que NÃO é idêntico ao que existe aqui (item ausente, diferente ou excluído lá)? */
function hasForeignData(local: DataSet, pull: PullResponse): boolean {
  const L = toMaps(local);
  return KINDS.some(kind => ((pull[kind] ?? []) as { id: string; deleted: boolean; data?: Entity }[]).some(e => (e.deleted ? L[kind].has(e.id) : !sameOpt(L[kind].get(e.id), e.data))));
}
const pulledCount = (p: PullResponse) => p.ingredients.length + p.recipes.length + p.orders.length + (p.packagings?.length ?? 0);

/**
 * Um ciclo de sincronização. Não altera os argumentos; devolve o novo estado.
 * Falhas de rede/autorização interrompem sem perder nada: o estado devolvido é o último consistente.
 * Reexecutar após uma falha é seguro (o servidor trata reenvios idênticos como "sem alteração").
 */
export async function syncOnce(api: SyncApi, local: DataSet, meta: SyncMeta, opts: { allowInitialMerge?: boolean; now?: Date } = {}): Promise<SyncResult> {
  let L = local, M = healConflicts(local, meta, opts.now), pulled = 0, pushed = 0;
  const newConflicts: ConflictRecord[] = [];
  const acknowledgedRecipes = new Map<string, { recipe: Recipe; revision: number }>();
  const result = (status: SyncStatus, message?: string): SyncResult => ({ status, message, local: L, meta: M, pulled, pushed, newConflicts });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const pull = await api.pull(M.revision);
      // Primeira sincronização com dados dos dois lados: só pede decisão se o servidor tiver algo diferente do local
      // (um reenvio depois de uma resposta perdida encontra tudo idêntico e segue sozinho).
      if (attempt === 0 && M.revision === 0 && isEmpty(M.baseline) && !isEmpty(L) && pulledCount(pull) > 0 && !opts.allowInitialMerge && hasForeignData(L, pull)) return result('needs-decision', 'Há dados neste dispositivo e na conta. Escolha como combinar.');
      pulled += pulledCount(pull);
      // Um Worker antigo pode responder sucesso e persistir os campos antigos de Recipe,
      // descartando packagingItems. Para este pull da mesma revisão aceita, trate isso
      // como limitação de compatibilidade: a base passa a refletir o eco real, mantendo
      // a escolha local pendente, sem inventar uma edição concorrente.
      const rejectedRecipePackaging = new Set<string>();
      const mergeMeta = { ...M, baseline: { ...M.baseline, recipes: [...M.baseline.recipes] } };
      const pulledRecipes = new Map((pull.recipes ?? []).map(entity => [entity.id, entity]));
      for (const [id, expected] of acknowledgedRecipes) {
        if (pull.revision < expected.revision) continue;
        const entity = pulledRecipes.get(id);
        if (entity?.deleted || (entity && entity.rev > expected.revision)) continue; // tombstone/edição posterior: segue o fluxo normal de conflito
        const mismatch = !entity ? true : !entity.data || !sameEntity(entity.data.packagingItems ?? [], expected.recipe.packagingItems ?? []);
        if (!mismatch || !(expected.recipe.packagingItems?.length)) continue;
        rejectedRecipePackaging.add(id);
        if (entity?.data) {
          const index = mergeMeta.baseline.recipes.findIndex(r => r.id === id);
          if (index < 0) mergeMeta.baseline.recipes.push(entity.data);
          else mergeMeta.baseline.recipes[index] = entity.data;
        }
      }
      const merged = applyPull(L, mergeMeta, pull, opts.now);
      L = merged.local; M = merged.meta; newConflicts.push(...merged.conflicts);
      if (rejectedRecipePackaging.size) return result('needs-attention', 'O servidor aceitou a receita, mas não confirmou suas embalagens. A alteração foi preservada neste dispositivo e não foi tratada como conflito. Atualize o Worker e o banco antes de tentar sincronizar essas embalagens novamente.');
      const dangling = findDanglingRefs(L);
      if (dangling.length) return result('needs-attention', dangling[0]);
      const pushes = buildPushes(L, M);
      if (!pushes.length) return result('synced');
      let again = false;
      let revision = M.revision;
      for (const req of pushes) {
        const resp = await api.push({ ...req, baseRevision: revision });
        if (!resp.ok && resp.kind === 'code') { // colisão rara de código gerado offline: troca o código das encomendas ainda não confirmadas e tenta de novo
          const taken = new Set(resp.orderIds), used = new Set(L.orders.map(o => o.quoteCode).filter((c): c is string => !!c));
          const orders = L.orders.map(o => (taken.has(o.id) ? { ...o, quoteCode: uniqueQuoteCode(used) } : o));
          L = { ...L, orders }; again = true; break;
        }
        if (!resp.ok) { again = true; break; } // mudou no servidor: puxa de novo, mescla e tenta outra vez
        revision = resp.revision; pushed += countOf(req);
        for (const recipe of req.upserts.recipes) if (recipe.packagingItems?.length) acknowledgedRecipes.set(recipe.id, { recipe, revision: resp.revision });
      }
      if (!again && attempt === 3) return result('error', 'Não foi possível concluir a sincronização. Tente novamente.');
    }
    return result('error', 'Não foi possível concluir a sincronização. Tente novamente.');
  } catch (e) {
    if (e instanceof SyncError) return result(e.kind === 'offline' ? 'offline' : e.kind === 'unauthorized' ? 'unauthorized' : e.kind === 'forbidden' ? 'forbidden' : e.kind === 'rejected' ? 'needs-attention' : 'error', e.message);
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
