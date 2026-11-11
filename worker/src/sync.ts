import { parseIngredient, parseOrder, parseRecipe, parseSettings } from '../../shared/dataset';
import { countChanges, KINDS, sameEntity, SYNC_LIMITS, type Conflict, type Kind, type PullEntity, type PullResponse, type PushOk, type PushRequest } from '../../shared/sync';
import type { Ingredient, Order, Recipe, Settings } from '../../src/domain/types';
import type { BoundStatement, D1Like } from './store';

/** Aplica/lê dados de UM usuário. Toda consulta filtra por user_id e usa parâmetros; nada é concatenado no SQL. */

const GUARD = (userIdParam: string, pushParam: string) => `EXISTS (SELECT 1 FROM sync_state WHERE user_id = ${userIdParam} AND last_push_id = ${pushParam})`;

type Row = Record<string, unknown>;
const num = (v: unknown) => v as number;
const ingredientOf = (r: Row): Ingredient => ({ id: r.id as string, name: r.name as string, unit: r.unit as Ingredient['unit'], purchaseQuantity: num(r.purchase_quantity), purchasePrice: num(r.purchase_price), ...(r.density_g_per_ml !== null ? { densityGPerMl: num(r.density_g_per_ml) } : {}), ...(r.grams_per_unit !== null ? { gramsPerUnit: num(r.grams_per_unit) } : {}) });
const recipeOf = (r: Row, items: Row[]): Recipe => ({ id: r.id as string, name: r.name as string, yield: num(r.yield), packagingPerUnit: num(r.packaging_per_unit), laborTotal: num(r.labor_total), extraTotal: num(r.extra_total), desiredMargin: num(r.desired_margin), items: items.map(i => ({ ingredientId: i.ingredient_id as string, quantity: num(i.quantity), ...(i.unit !== null ? { unit: i.unit as NonNullable<Recipe['items'][number]['unit']> } : {}) })) });
const orderOf = (r: Row): Order => ({ id: r.id as string, customer: r.customer as string, recipeId: r.recipe_id as string, quantity: num(r.quantity), unitPrice: num(r.unit_price), deposit: num(r.deposit), deliveryDate: r.delivery_date as string, status: r.status as Order['status'], createdAt: r.created_at as string, ...(r.cost_per_unit !== null ? { costSnapshot: { costPerUnit: num(r.cost_per_unit), capturedAt: r.cost_captured_at as string } } : {}) });

const same = sameEntity;

export type SyncState = { revision: number; settingsRev: number; settings: Settings | null };
export async function getState(db: D1Like, userId: string, now: string): Promise<SyncState> {
  await db.prepare('INSERT OR IGNORE INTO sync_state (user_id, revision, updated_at) VALUES (?, 0, ?)').bind(userId, now).run();
  const r = await db.prepare('SELECT revision, settings_rev, settings_json FROM sync_state WHERE user_id = ?').bind(userId).first<{ revision: number; settings_rev: number; settings_json: string | null }>();
  return { revision: r?.revision ?? 0, settingsRev: r?.settings_rev ?? 0, settings: r?.settings_json ? (JSON.parse(r.settings_json) as Settings) : null };
}

const itemsOf = async (db: D1Like, userId: string, recipeIds: string[]): Promise<Map<string, Row[]>> => {
  const map = new Map<string, Row[]>();
  if (!recipeIds.length) return map;
  const r = await db.prepare('SELECT recipe_id, position, ingredient_id, quantity, unit FROM recipe_items WHERE user_id = ?1 AND recipe_id IN (SELECT value FROM json_each(?2)) ORDER BY recipe_id, position').bind(userId, JSON.stringify(recipeIds)).all<Row>();
  for (const row of r.results) { const k = row.recipe_id as string; map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
};

/** Alterações com revisão > `since` (inclui exclusões lógicas). `since = 0` devolve tudo. */
export async function pull(db: D1Like, userId: string, since: number, now: string): Promise<PullResponse> {
  const state = await getState(db, userId, now);
  const q = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND rev > ?2 ORDER BY rev, id`).bind(userId, since).all<Row>();
  const [ing, rec, ord] = await Promise.all([q('ingredients'), q('recipes'), q('orders')]);
  const items = await itemsOf(db, userId, rec.results.filter(r => r.deleted_at === null).map(r => r.id as string));
  const entity = <T,>(r: Row, data: () => T): PullEntity<T> => (r.deleted_at !== null ? { id: r.id as string, rev: num(r.rev), deleted: true } : { id: r.id as string, rev: num(r.rev), deleted: false, data: data() });
  return {
    revision: state.revision,
    ingredients: ing.results.map(r => entity(r, () => ingredientOf(r))),
    recipes: rec.results.map(r => entity(r, () => recipeOf(r, items.get(r.id as string) ?? []))),
    orders: ord.results.map(r => entity(r, () => orderOf(r))),
    ...(state.settings && state.settingsRev > since ? { settings: { rev: state.settingsRev, data: state.settings } } : {}),
  };
}

type Existing<T> = { rev: number; deleted: boolean; entity: T };
async function existing<T>(db: D1Like, userId: string, table: 'ingredients' | 'recipes' | 'orders', ids: string[], map: (r: Row) => T): Promise<Map<string, Existing<T>>> {
  const out = new Map<string, Existing<T>>();
  if (!ids.length) return out;
  const r = await db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(userId, JSON.stringify(ids)).all<Row>();
  for (const row of r.results) out.set(row.id as string, { rev: num(row.rev), deleted: row.deleted_at !== null, entity: map(row) });
  return out;
}
const activeIds = async (db: D1Like, userId: string, table: 'ingredients' | 'recipes'): Promise<Set<string>> =>
  new Set((await db.prepare(`SELECT id FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`).bind(userId).all<{ id: string }>()).results.map(r => r.id));

export type PushOutcome =
  | { ok: true; result: PushOk }
  | { ok: false; status: 400 | 409 | 413 | 422; body: Record<string, unknown> };
const bad = (status: 400 | 409 | 413 | 422, body: Record<string, unknown>): PushOutcome => ({ ok: false, status, body });

const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isRevMap = (v: unknown): v is Record<string, number> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => Number.isInteger(x) && (x as number) >= 0);

/** Valida o formato do corpo (o conteúdo das entidades é validado depois, com as regras do backup). */
export function parsePushRequest(raw: unknown): PushRequest | string {
  const r = raw as Partial<PushRequest> | null;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.baseRevision) || (r.baseRevision as number) < 0) return 'baseRevision inválida.';
  const b = r.baseRevs, u = r.upserts, d = r.deletes;
  if (!b || !u || !d) return 'Corpo incompleto.';
  for (const k of KINDS) {
    if (!isRevMap(b[k]) || !Array.isArray(u[k]) || !isIds(d[k])) return `Campo "${k}" inválido.`;
  }
  if (b.settings !== undefined && (!Number.isInteger(b.settings) || b.settings < 0)) return 'Revisão de configurações inválida.';
  return r as PushRequest;
}

export async function push(db: D1Like, userId: string, req: PushRequest, now: string, newPushId: string): Promise<PushOutcome> {
  if (countChanges(req) > SYNC_LIMITS.maxChangesPerPush) return bad(413, { error: 'TOO_MANY_CHANGES', message: `Envie no máximo ${SYNC_LIMITS.maxChangesPerPush} alterações por vez.` });
  const state = await getState(db, userId, now);
  if (req.baseRevision > state.revision) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Revisão base maior que a do servidor.' });

  // ---- valida o conteúdo das entidades (mesmas regras do backup) ----
  const activeIng = await activeIds(db, userId, 'ingredients');
  const activeRec = await activeIds(db, userId, 'recipes');
  const delIng = new Set(req.deletes.ingredients), delRec = new Set(req.deletes.recipes);
  let ingredients: Ingredient[], recipes: Recipe[], orders: Order[], settings: Settings | undefined;
  try {
    ingredients = req.upserts.ingredients.map(parseIngredient);
    const effIng = new Set([...activeIng, ...ingredients.map(i => i.id)].filter(id => !delIng.has(id) || ingredients.some(i => i.id === id)));
    recipes = req.upserts.recipes.map(r => parseRecipe(r, effIng));
    const effRec = new Set([...activeRec, ...recipes.map(r => r.id)].filter(id => !delRec.has(id) || recipes.some(r => r.id === id)));
    orders = req.upserts.orders.map(o => parseOrder(o, effRec));
    settings = req.upserts.settings === undefined ? undefined : parseSettings(req.upserts.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dados inválidos.';
    return bad(/inexistente/.test(message) ? 422 : 400, { error: /inexistente/.test(message) ? 'REFERENCE_ERROR' : 'INVALID_PAYLOAD', message });
  }
  const ids = <T extends { id: string }>(list: T[]) => list.map(x => x.id);
  if (new Set(ids(ingredients)).size !== ingredients.length || new Set(ids(recipes)).size !== recipes.length || new Set(ids(orders)).size !== orders.length) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Identificadores repetidos no mesmo envio.' });
  for (const [k, list] of [['ingredients', ids(ingredients)], ['recipes', ids(recipes)], ['orders', ids(orders)]] as const) {
    if (list.some(id => req.deletes[k].includes(id))) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Uma entidade não pode ser alterada e excluída no mesmo envio.' });
  }

  // ---- conflitos: alguma entidade mudou no servidor depois da revisão que o cliente conhecia? ----
  const [exIng, exRec, exOrd] = await Promise.all([
    existing(db, userId, 'ingredients', [...ids(ingredients), ...req.deletes.ingredients], ingredientOf),
    existing(db, userId, 'recipes', [...ids(recipes), ...req.deletes.recipes], r => r as unknown as Recipe),
    existing(db, userId, 'orders', [...ids(orders), ...req.deletes.orders], orderOf),
  ]);
  const recItems = await itemsOf(db, userId, [...exRec.keys()]);
  for (const [id, e] of exRec) e.entity = recipeOf(e.entity as unknown as Row, recItems.get(id) ?? []);

  const conflicts: Conflict[] = [];
  const toUpsert = { ingredients: [] as Ingredient[], recipes: [] as Recipe[], orders: [] as Order[] };
  const toDelete = { ingredients: [] as string[], recipes: [] as string[], orders: [] as string[] };
  const examine = <T extends { id: string }>(kind: Kind, list: T[], ex: Map<string, Existing<T>>, out: T[]) => {
    for (const e of list) {
      const cur = ex.get(e.id);
      if (!cur) { out.push(e); continue; }
      if (cur.rev > (req.baseRevs[kind][e.id] ?? 0)) { if (!cur.deleted && same(cur.entity, e)) continue; conflicts.push({ kind, id: e.id, serverRev: cur.rev }); continue; }
      out.push(e);
    }
  };
  const examineDeletes = <T,>(kind: Kind, idList: string[], ex: Map<string, Existing<T>>, out: string[]) => {
    for (const id of idList) {
      const cur = ex.get(id);
      if (!cur || cur.deleted) continue; // nada a excluir
      if (cur.rev > (req.baseRevs[kind][id] ?? 0)) { conflicts.push({ kind, id, serverRev: cur.rev }); continue; }
      out.push(id);
    }
  };
  examine('ingredients', ingredients, exIng, toUpsert.ingredients); examine('recipes', recipes, exRec as Map<string, Existing<Recipe>>, toUpsert.recipes); examine('orders', orders, exOrd, toUpsert.orders);
  examineDeletes('ingredients', req.deletes.ingredients, exIng, toDelete.ingredients); examineDeletes('recipes', req.deletes.recipes, exRec, toDelete.recipes); examineDeletes('orders', req.deletes.orders, exOrd, toDelete.orders);
  let settingsChanged = false;
  if (settings) {
    if (state.settingsRev > (req.baseRevs.settings ?? 0) && state.settings && !same(state.settings, settings)) conflicts.push({ kind: 'settings', id: 'settings', serverRev: state.settingsRev });
    else settingsChanged = !state.settings || !same(state.settings, settings);
  }
  if (conflicts.length) return bad(409, { error: 'CONFLICT', conflicts, revision: state.revision });

  // ---- integridade referencial das exclusões ----
  if (toDelete.ingredients.length) {
    const inPush = [...ids(recipes), ...req.deletes.recipes];
    const used = await db.prepare(`SELECT DISTINCT ri.ingredient_id AS id FROM recipe_items ri JOIN recipes r ON r.user_id = ri.user_id AND r.id = ri.recipe_id
      WHERE ri.user_id = ?1 AND r.deleted_at IS NULL AND ri.ingredient_id IN (SELECT value FROM json_each(?2)) AND ri.recipe_id NOT IN (SELECT value FROM json_each(?3))`).bind(userId, JSON.stringify(toDelete.ingredients), JSON.stringify(inPush)).all<{ id: string }>();
    if (used.results.length) return bad(422, { error: 'REFERENCE_ERROR', message: 'Há receitas que usam um ingrediente que seria excluído.' });
  }
  if (toDelete.recipes.length) {
    const inPush = [...ids(orders), ...req.deletes.orders];
    const used = await db.prepare(`SELECT DISTINCT recipe_id AS id FROM orders WHERE user_id = ?1 AND deleted_at IS NULL AND recipe_id IN (SELECT value FROM json_each(?2)) AND id NOT IN (SELECT value FROM json_each(?3))`).bind(userId, JSON.stringify(toDelete.recipes), JSON.stringify(inPush)).all<{ id: string }>();
    if (used.results.length) return bad(422, { error: 'REFERENCE_ERROR', message: 'Há encomendas que usam uma receita que seria excluída.' });
  }

  const nothing = !toUpsert.ingredients.length && !toUpsert.recipes.length && !toUpsert.orders.length && !toDelete.ingredients.length && !toDelete.recipes.length && !toDelete.orders.length && !settingsChanged;
  if (nothing) return { ok: true, result: { revision: state.revision, changed: false } }; // reenvio idêntico: nada a fazer

  // ---- grava: UMA transação; a primeira instrução só passa se a revisão ainda for a que lemos ----
  const rev = state.revision + 1;
  const p = (sql: string, ...v: unknown[]): BoundStatement => db.prepare(sql).bind(...v);
  const g = (a: string, b: string) => GUARD(a, b);
  const batch: BoundStatement[] = [p('UPDATE sync_state SET revision = ?1, last_push_id = ?2, updated_at = ?3 WHERE user_id = ?4 AND revision = ?5', rev, newPushId, now, userId, state.revision)];
  for (const i of toUpsert.ingredients) {
    batch.push(p(`INSERT INTO ingredients (user_id, id, name, unit, purchase_quantity, purchase_price, density_g_per_ml, grams_per_unit, rev, deleted_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL WHERE ${g('?1', '?10')}
      ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, unit = excluded.unit, purchase_quantity = excluded.purchase_quantity, purchase_price = excluded.purchase_price,
        density_g_per_ml = excluded.density_g_per_ml, grams_per_unit = excluded.grams_per_unit, rev = excluded.rev, deleted_at = NULL`, userId, i.id, i.name, i.unit, i.purchaseQuantity, i.purchasePrice, i.densityGPerMl ?? null, i.gramsPerUnit ?? null, rev, newPushId));
  }
  for (const r of toUpsert.recipes) {
    batch.push(p(`INSERT INTO recipes (user_id, id, name, yield, packaging_per_unit, labor_total, extra_total, desired_margin, rev, deleted_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL WHERE ${g('?1', '?10')}
      ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, yield = excluded.yield, packaging_per_unit = excluded.packaging_per_unit, labor_total = excluded.labor_total,
        extra_total = excluded.extra_total, desired_margin = excluded.desired_margin, rev = excluded.rev, deleted_at = NULL`, userId, r.id, r.name, r.yield, r.packagingPerUnit, r.laborTotal, r.extraTotal, r.desiredMargin, rev, newPushId));
    batch.push(p(`DELETE FROM recipe_items WHERE user_id = ?1 AND recipe_id = ?2 AND ${g('?1', '?3')}`, userId, r.id, newPushId));
    batch.push(p(`INSERT INTO recipe_items (user_id, recipe_id, position, ingredient_id, quantity, unit)
      SELECT ?1, ?2, CAST(j.key AS INTEGER), json_extract(j.value, '$.ingredientId'), json_extract(j.value, '$.quantity'), json_extract(j.value, '$.unit') FROM json_each(?3) AS j WHERE ${g('?1', '?4')}`, userId, r.id, JSON.stringify(r.items), newPushId));
  }
  for (const o of toUpsert.orders) {
    batch.push(p(`INSERT INTO orders (user_id, id, customer, recipe_id, quantity, unit_price, deposit, delivery_date, status, created_at, cost_per_unit, cost_captured_at, rev, deleted_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL WHERE ${g('?1', '?14')}
      ON CONFLICT (user_id, id) DO UPDATE SET customer = excluded.customer, recipe_id = excluded.recipe_id, quantity = excluded.quantity, unit_price = excluded.unit_price, deposit = excluded.deposit,
        delivery_date = excluded.delivery_date, status = excluded.status, created_at = excluded.created_at, cost_per_unit = excluded.cost_per_unit, cost_captured_at = excluded.cost_captured_at, rev = excluded.rev, deleted_at = NULL`,
      userId, o.id, o.customer, o.recipeId, o.quantity, o.unitPrice, o.deposit, o.deliveryDate, o.status, o.createdAt, o.costSnapshot?.costPerUnit ?? null, o.costSnapshot?.capturedAt ?? null, rev, newPushId));
  }
  for (const id of toDelete.ingredients) batch.push(p(`UPDATE ingredients SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
  for (const id of toDelete.recipes) {
    batch.push(p(`UPDATE recipes SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
    batch.push(p(`DELETE FROM recipe_items WHERE user_id = ?1 AND recipe_id = ?2 AND ${g('?1', '?3')}`, userId, id, newPushId));
  }
  for (const id of toDelete.orders) batch.push(p(`UPDATE orders SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
  if (settingsChanged && settings) batch.push(p('UPDATE sync_state SET settings_json = ?2, settings_rev = ?3 WHERE user_id = ?1 AND last_push_id = ?4', userId, JSON.stringify(settings), rev, newPushId));

  const results = await db.batch(batch);
  if ((results[0]?.meta.changes ?? 0) !== 1) return bad(409, { error: 'STALE', revision: (await getState(db, userId, now)).revision }); // outro envio ganhou a corrida; nada foi aplicado
  return { ok: true, result: { revision: rev, changed: true } };
}
