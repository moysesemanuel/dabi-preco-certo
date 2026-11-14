import { parseCatalogRef, parseIngredient, parseOrder, parsePackaging, parseRecipe, parseSettings } from '../../shared/dataset';
import { countChanges, KINDS, sameEntity, SYNC_LIMITS, type Conflict, type Kind, type PullEntity, type PullResponse, type PushOk, type PushRequest } from '../../shared/sync';
import type { Ingredient, Order, Packaging, Payment, Recipe, Settings } from '../../src/domain/types';
import type { BoundStatement, D1Like } from './store';

/** Aplica/lê dados de UM usuário. Toda consulta filtra por user_id e usa parâmetros; nada é concatenado no SQL. */

const GUARD = (userIdParam: string, pushParam: string) => `EXISTS (SELECT 1 FROM sync_state WHERE user_id = ${userIdParam} AND last_push_id = ${pushParam})`;

type Row = Record<string, unknown>;
const num = (v: unknown) => v as number;
const ingredientOf = (r: Row): Ingredient => ({ id: r.id as string, name: r.name as string, unit: r.unit as Ingredient['unit'], purchaseQuantity: num(r.purchase_quantity), purchasePrice: num(r.purchase_price), ...(r.density_g_per_ml !== null ? { densityGPerMl: num(r.density_g_per_ml) } : {}), ...(r.grams_per_unit !== null ? { gramsPerUnit: num(r.grams_per_unit) } : {}), ...(typeof r.catalog_ref === 'string' ? catalogRefOf(r.catalog_ref) : {}) });
const packagingOf = (r: Row): Packaging => ({ id: r.id as string, name: r.name as string, purchasePrice: num(r.purchase_price), purchaseQuantity: num(r.purchase_quantity), ...(r.capacity !== null ? { capacity: num(r.capacity) } : {}), active: num(r.active) === 1 });
/** Lê a referência do catálogo gravada (JSON). Valor ilegível é ignorado em vez de derrubar a leitura. */
const catalogRefOf = (json: string): Pick<Ingredient, 'catalogRef'> => { try { return { catalogRef: parseCatalogRef(JSON.parse(json)) }; } catch { return {}; } };
const recipeOf = (r: Row, items: Row[], packs: Row[] = []): Recipe => ({ id: r.id as string, name: r.name as string, yield: num(r.yield), packagingPerUnit: num(r.packaging_per_unit), laborTotal: num(r.labor_total), extraTotal: num(r.extra_total), desiredMargin: num(r.desired_margin), ...(r.prep_minutes !== null ? { prepMinutes: num(r.prep_minutes) } : {}), items: items.map(i => ({ ingredientId: i.ingredient_id as string, quantity: num(i.quantity), ...(i.unit !== null ? { unit: i.unit as NonNullable<Recipe['items'][number]['unit']> } : {}) })), ...(packs.length ? { packagingItems: packs.map(p => ({ packagingId: p.packaging_id as string, quantityPerUnit: num(p.quantity_per_unit) })) } : {}) });
const paymentOf = (p: Row): Payment => ({ id: p.id as string, amount: num(p.amount), receivedAt: p.received_at as string, ...(p.method !== null ? { method: p.method as NonNullable<Payment['method']> } : {}), ...(p.note !== null ? { note: p.note as string } : {}) });
const jsonArray = <T,>(value: unknown): T[] => { try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; } };
const orderOf = (r: Row, pays: Row[] = []): Order => { const packagings = jsonArray<NonNullable<Order['packagingItems']>[number]>(r.packaging_items_json); const costPackagings = jsonArray<NonNullable<NonNullable<Order['costSnapshot']>['packagingItems']>[number]>(r.cost_snapshot_packaging_json); const packagingCharge = num(r.packaging_charge); return { id: r.id as string, customer: r.customer as string, recipeId: r.recipe_id as string, quantity: num(r.quantity), unitPrice: num(r.unit_price), deposit: num(r.deposit), deliveryDate: r.delivery_date as string, status: r.status as Order['status'], createdAt: r.created_at as string, ...(packagingCharge > 0 ? { packagingCharge } : {}), ...(packagings.length ? { packagingItems: packagings } : {}), ...(r.cost_per_unit !== null ? { costSnapshot: { costPerUnit: num(r.cost_per_unit), capturedAt: r.cost_captured_at as string, ...(costPackagings.length ? { packagingItems: costPackagings } : {}) } } : {}), ...(pays.length ? { payments: pays.map(paymentOf) } : {}), ...(typeof r.quote_code === 'string' ? { quoteCode: r.quote_code } : {}) }; };

const same = sameEntity;

export type SyncState = { revision: number; settingsRev: number; settings: Settings | null };
export async function getState(db: D1Like, userId: string, now: string): Promise<SyncState> {
  type Row = { revision: number; settings_rev: number; settings_json: string | null };
  const read = () => db.prepare('SELECT revision, settings_rev, settings_json FROM sync_state WHERE user_id = ?').bind(userId).first<Row>();
  let r = await read(); // caso comum (conta já existe): 1 consulta em vez de 2
  if (!r) { await db.prepare('INSERT OR IGNORE INTO sync_state (user_id, revision, updated_at) VALUES (?, 0, ?)').bind(userId, now).run(); r = await read(); }
  return { revision: r?.revision ?? 0, settingsRev: r?.settings_rev ?? 0, settings: r?.settings_json ? (JSON.parse(r.settings_json) as Settings) : null };
}

const itemsOf = async (db: D1Like, userId: string, recipeIds: string[]): Promise<Map<string, Row[]>> => {
  const map = new Map<string, Row[]>();
  if (!recipeIds.length) return map;
  const r = await db.prepare('SELECT recipe_id, position, ingredient_id, quantity, unit FROM recipe_items WHERE user_id = ?1 AND recipe_id IN (SELECT value FROM json_each(?2)) ORDER BY recipe_id, position').bind(userId, JSON.stringify(recipeIds)).all<Row>();
  for (const row of r.results) { const k = row.recipe_id as string; map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
};
const recipePackagingsOf = async (db: D1Like, userId: string, recipeIds: string[]): Promise<Map<string, Row[]>> => {
  const map = new Map<string, Row[]>(); if (!recipeIds.length) return map;
  const result = await db.prepare('SELECT recipe_id, packaging_id, quantity_per_unit FROM recipe_packaging_items WHERE user_id = ?1 AND recipe_id IN (SELECT value FROM json_each(?2)) ORDER BY recipe_id, position').bind(userId, JSON.stringify(recipeIds)).all<Row>();
  for (const row of result.results) { const key = row.recipe_id as string; map.set(key, [...(map.get(key) ?? []), row]); }
  return map;
};

const paymentsFor = async (db: D1Like, userId: string, orderIds: string[]): Promise<Map<string, Row[]>> => {
  const map = new Map<string, Row[]>();
  if (!orderIds.length) return map;
  const r = await db.prepare('SELECT order_id, position, id, amount, received_at, method, note FROM order_payments WHERE user_id = ?1 AND order_id IN (SELECT value FROM json_each(?2)) ORDER BY order_id, position').bind(userId, JSON.stringify(orderIds)).all<Row>();
  for (const row of r.results) { const k = row.order_id as string; map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
};

/** Alterações com revisão > `since` (inclui exclusões lógicas). `since = 0` devolve tudo. */
export async function pull(db: D1Like, userId: string, since: number, now: string): Promise<PullResponse> {
  const state = await getState(db, userId, now);
  const q = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND rev > ?2 ORDER BY rev, id`).bind(userId, since).all<Row>();
  const [ing, rec, ord, packs] = await Promise.all([q('ingredients'), q('recipes'), q('orders'), q('packagings')]);
  const items = await itemsOf(db, userId, rec.results.filter(r => r.deleted_at === null).map(r => r.id as string));
  const recipePacks = await recipePackagingsOf(db, userId, rec.results.filter(r => r.deleted_at === null).map(r => r.id as string));
  const pays = await paymentsFor(db, userId, ord.results.filter(r => r.deleted_at === null).map(r => r.id as string));
  const entity = <T,>(r: Row, data: () => T): PullEntity<T> => (r.deleted_at !== null ? { id: r.id as string, rev: num(r.rev), deleted: true } : { id: r.id as string, rev: num(r.rev), deleted: false, data: data() });
  return {
    revision: state.revision,
    ingredients: ing.results.map(r => entity(r, () => ingredientOf(r))),
    recipes: rec.results.map(r => entity(r, () => recipeOf(r, items.get(r.id as string) ?? [], recipePacks.get(r.id as string) ?? []))),
    orders: ord.results.map(r => entity(r, () => orderOf(r, pays.get(r.id as string) ?? []))),
    packagings: packs.results.map(r => entity(r, () => packagingOf(r))),
    ...(state.settings && state.settingsRev > since ? { settings: { rev: state.settingsRev, data: state.settings } } : {}),
  };
}

type Existing<T> = { rev: number; deleted: boolean; entity: T };
async function existing<T>(db: D1Like, userId: string, table: 'ingredients' | 'recipes' | 'orders' | 'packagings', ids: string[], map: (r: Row) => T): Promise<Map<string, Existing<T>>> {
  const out = new Map<string, Existing<T>>();
  if (!ids.length) return out;
  const r = await db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(userId, JSON.stringify(ids)).all<Row>();
  for (const row of r.results) out.set(row.id as string, { rev: num(row.rev), deleted: row.deleted_at !== null, entity: map(row) });
  return out;
}
/**
 * Quais dos ids INFORMADOS existem e estão ativos. Só os ids que o envio referencia são consultados (pela chave primária):
 * ler a lista inteira de ids ativos da conta a cada envio custava uma linha lida por ingrediente/receita, e crescia com a conta.
 */
const activeIds = async (db: D1Like, userId: string, table: 'ingredients' | 'recipes' | 'packagings', wanted: Iterable<string>): Promise<Set<string>> => {
  const ids = [...new Set(wanted)];
  if (!ids.length) return new Set();
  const r = await db.prepare(`SELECT id FROM ${table} WHERE user_id = ?1 AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))`).bind(userId, JSON.stringify(ids)).all<{ id: string }>();
  return new Set(r.results.map(x => x.id));
};
/** Ids referenciados (texto) em uma lista ainda NÃO validada; entradas de formato inesperado são ignoradas aqui e recusadas depois pela validação. */
const referenced = (list: unknown[], pick: (item: Record<string, unknown>) => unknown[]): string[] =>
  list.flatMap(x => (typeof x === 'object' && x !== null ? pick(x as Record<string, unknown>) : [])).filter((v): v is string => typeof v === 'string' && v.length <= 64);

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
    if (k === 'packagings' && b[k] === undefined && u[k] === undefined && d[k] === undefined) continue;
    if (!isRevMap(b[k]) || !Array.isArray(u[k]) || !isIds(d[k])) return `Campo "${k}" inválido.`;
  }
  if (b.settings !== undefined && (!Number.isInteger(b.settings) || b.settings < 0)) return 'Revisão de configurações inválida.';
  return { ...r, baseRevs: { ...b, packagings: b.packagings ?? {} }, upserts: { ...u, packagings: u.packagings ?? [] }, deletes: { ...d, packagings: d.packagings ?? [] } } as PushRequest;
}

export async function push(db: D1Like, userId: string, req: PushRequest, now: string, newPushId: string): Promise<PushOutcome> {
  if (countChanges(req) > SYNC_LIMITS.maxChangesPerPush) return bad(413, { error: 'TOO_MANY_CHANGES', message: `Envie no máximo ${SYNC_LIMITS.maxChangesPerPush} alterações por vez.` });
  const state = await getState(db, userId, now);
  if (req.baseRevision > state.revision) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Revisão base maior que a do servidor.' });

  // ---- valida o conteúdo das entidades (mesmas regras do backup) ----
  const activeIng = await activeIds(db, userId, 'ingredients', referenced(req.upserts.recipes as unknown[], r => (Array.isArray(r.items) ? r.items.map(i => (typeof i === 'object' && i !== null ? (i as Record<string, unknown>).ingredientId : undefined)) : [])));
  const activeRec = await activeIds(db, userId, 'recipes', referenced(req.upserts.orders as unknown[], o => [o.recipeId]));
  const activePacks = await activeIds(db, userId, 'packagings', referenced(req.upserts.recipes as unknown[], r => Array.isArray(r.packagingItems) ? r.packagingItems.map(x => typeof x === 'object' && x !== null ? (x as Record<string, unknown>).packagingId : undefined) : []).concat(referenced(req.upserts.orders as unknown[], o => Array.isArray(o.packagingItems) ? o.packagingItems.map(x => typeof x === 'object' && x !== null ? (x as Record<string, unknown>).packagingId : undefined) : [])));
  const delIng = new Set(req.deletes.ingredients), delRec = new Set(req.deletes.recipes), delPacks = new Set(req.deletes.packagings);
  let ingredients: Ingredient[], recipes: Recipe[], orders: Order[], packagings: Packaging[], settings: Settings | undefined;
  try {
    ingredients = req.upserts.ingredients.map(parseIngredient);
    packagings = req.upserts.packagings.map(parsePackaging);
    const effIng = new Set([...activeIng, ...ingredients.map(i => i.id)].filter(id => !delIng.has(id) || ingredients.some(i => i.id === id)));
    const effPacks = new Set([...activePacks, ...packagings.map(p => p.id)].filter(id => !delPacks.has(id) || packagings.some(p => p.id === id)));
    recipes = req.upserts.recipes.map(r => parseRecipe(r, effIng, effPacks));
    const effRec = new Set([...activeRec, ...recipes.map(r => r.id)].filter(id => !delRec.has(id) || recipes.some(r => r.id === id)));
    orders = req.upserts.orders.map(o => parseOrder(o, effRec, effPacks));
    settings = req.upserts.settings === undefined ? undefined : parseSettings(req.upserts.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dados inválidos.';
    return bad(/inexistente/.test(message) ? 422 : 400, { error: /inexistente/.test(message) ? 'REFERENCE_ERROR' : 'INVALID_PAYLOAD', message });
  }
  const ids = <T extends { id: string }>(list: T[]) => list.map(x => x.id);
  if (new Set(ids(ingredients)).size !== ingredients.length || new Set(ids(recipes)).size !== recipes.length || new Set(ids(orders)).size !== orders.length || new Set(ids(packagings)).size !== packagings.length) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Identificadores repetidos no mesmo envio.' });
  for (const [k, list] of [['ingredients', ids(ingredients)], ['recipes', ids(recipes)], ['orders', ids(orders)], ['packagings', ids(packagings)]] as const) {
    if (list.some(id => req.deletes[k].includes(id))) return bad(400, { error: 'INVALID_PAYLOAD', message: 'Uma entidade não pode ser alterada e excluída no mesmo envio.' });
  }

  // ---- conflitos: alguma entidade mudou no servidor depois da revisão que o cliente conhecia? ----
  const [exIng, exRec, exOrd, exPack] = await Promise.all([
    existing(db, userId, 'ingredients', [...ids(ingredients), ...req.deletes.ingredients], ingredientOf),
    existing(db, userId, 'recipes', [...ids(recipes), ...req.deletes.recipes], r => r as unknown as Recipe),
    existing(db, userId, 'orders', [...ids(orders), ...req.deletes.orders], r => r as unknown as Order),
    existing(db, userId, 'packagings', [...ids(packagings), ...req.deletes.packagings], packagingOf),
  ]);
  const recItems = await itemsOf(db, userId, [...exRec.keys()]);
  const recPacks = await recipePackagingsOf(db, userId, [...exRec.keys()]);
  for (const [id, e] of exRec) e.entity = recipeOf(e.entity as unknown as Row, recItems.get(id) ?? [], recPacks.get(id) ?? []);
  const ordPays = await paymentsFor(db, userId, [...exOrd.keys()]);
  for (const [id, e] of exOrd) e.entity = orderOf(e.entity as unknown as Row, ordPays.get(id) ?? []);
  // O código de atendimento é permanente: se a encomenda já tem um no servidor, ele prevalece (um envio sem código ou com outro valor não o altera).
  orders = orders.map(o => { const kept = exOrd.get(o.id)?.entity.quoteCode; return kept && o.quoteCode !== kept ? { ...o, quoteCode: kept } : o; });

  const conflicts: Conflict[] = [];
  const toUpsert = { ingredients: [] as Ingredient[], recipes: [] as Recipe[], orders: [] as Order[], packagings: [] as Packaging[] };
  const toDelete = { ingredients: [] as string[], recipes: [] as string[], orders: [] as string[], packagings: [] as string[] };
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
  examine('ingredients', ingredients, exIng, toUpsert.ingredients); examine('recipes', recipes, exRec as Map<string, Existing<Recipe>>, toUpsert.recipes); examine('orders', orders, exOrd, toUpsert.orders); examine('packagings', packagings, exPack, toUpsert.packagings);
  examineDeletes('ingredients', req.deletes.ingredients, exIng, toDelete.ingredients); examineDeletes('recipes', req.deletes.recipes, exRec, toDelete.recipes); examineDeletes('orders', req.deletes.orders, exOrd, toDelete.orders); examineDeletes('packagings', req.deletes.packagings, exPack, toDelete.packagings);
  let settingsChanged = false;
  if (settings) {
    if (state.settingsRev > (req.baseRevs.settings ?? 0) && state.settings && !same(state.settings, settings)) conflicts.push({ kind: 'settings', id: 'settings', serverRev: state.settingsRev });
    else settingsChanged = !state.settings || !same(state.settings, settings);
  }
  if (conflicts.length) return bad(409, { error: 'CONFLICT', conflicts, revision: state.revision });

  // ---- unicidade do código de atendimento por conta (inclui encomendas excluídas) ----
  const coded = toUpsert.orders.filter(o => o.quoteCode);
  if (coded.length) {
    const taken = new Set<string>(), firstOf = new Map<string, string>();
    for (const o of coded) { if (firstOf.has(o.quoteCode!)) taken.add(o.id); else firstOf.set(o.quoteCode!, o.id); }
    const rows = await db.prepare('SELECT id, quote_code FROM orders WHERE user_id = ?1 AND quote_code IN (SELECT value FROM json_each(?2))').bind(userId, JSON.stringify([...firstOf.keys()])).all<{ id: string; quote_code: string }>();
    for (const r of rows.results) { const mine = firstOf.get(r.quote_code); if (mine && mine !== r.id) taken.add(mine); }
    if (taken.size) return bad(409, { error: 'CODE_TAKEN', orderIds: [...taken], revision: state.revision });
  }

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
  if (toDelete.packagings.length) {
    const inPush = [...ids(recipes), ...req.deletes.recipes];
    const used = await db.prepare(`SELECT DISTINCT packaging_id AS id FROM recipe_packaging_items ri JOIN recipes r ON r.user_id = ri.user_id AND r.id = ri.recipe_id
      WHERE ri.user_id = ?1 AND r.deleted_at IS NULL AND ri.packaging_id IN (SELECT value FROM json_each(?2)) AND ri.recipe_id NOT IN (SELECT value FROM json_each(?3))`).bind(userId, JSON.stringify(toDelete.packagings), JSON.stringify(inPush)).all<{ id: string }>();
    if (used.results.length) return bad(422, { error: 'REFERENCE_ERROR', message: 'Há receitas que usam uma embalagem que seria excluída. Desative-a em vez de excluí-la.' });
  }

  const nothing = !toUpsert.ingredients.length && !toUpsert.recipes.length && !toUpsert.orders.length && !toUpsert.packagings.length && !toDelete.ingredients.length && !toDelete.recipes.length && !toDelete.orders.length && !toDelete.packagings.length && !settingsChanged;
  if (nothing) return { ok: true, result: { revision: state.revision, changed: false } }; // reenvio idêntico: nada a fazer

  // ---- grava: UMA transação; a primeira instrução só passa se a revisão ainda for a que lemos ----
  const rev = state.revision + 1;
  const p = (sql: string, ...v: unknown[]): BoundStatement => db.prepare(sql).bind(...v);
  const g = (a: string, b: string) => GUARD(a, b);
  const batch: BoundStatement[] = [p('UPDATE sync_state SET revision = ?1, last_push_id = ?2, updated_at = ?3 WHERE user_id = ?4 AND revision = ?5', rev, newPushId, now, userId, state.revision)];
  for (const x of toUpsert.packagings) batch.push(p(`INSERT INTO packagings (user_id,id,name,purchase_price,purchase_quantity,capacity,active,rev,deleted_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,NULL WHERE ${g('?1','?9')} ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,purchase_price=excluded.purchase_price,purchase_quantity=excluded.purchase_quantity,capacity=excluded.capacity,active=excluded.active,rev=excluded.rev,deleted_at=NULL`, userId,x.id,x.name,x.purchasePrice,x.purchaseQuantity,x.capacity??null,x.active?1:0,rev,newPushId));
  for (const i of toUpsert.ingredients) {
    batch.push(p(`INSERT INTO ingredients (user_id, id, name, unit, purchase_quantity, purchase_price, density_g_per_ml, grams_per_unit, catalog_ref, rev, deleted_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?11, ?9, NULL WHERE ${g('?1', '?10')}
      ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, unit = excluded.unit, purchase_quantity = excluded.purchase_quantity, purchase_price = excluded.purchase_price,
        density_g_per_ml = excluded.density_g_per_ml, grams_per_unit = excluded.grams_per_unit, catalog_ref = excluded.catalog_ref, rev = excluded.rev, deleted_at = NULL`, userId, i.id, i.name, i.unit, i.purchaseQuantity, i.purchasePrice, i.densityGPerMl ?? null, i.gramsPerUnit ?? null, rev, newPushId, i.catalogRef ? JSON.stringify(i.catalogRef) : null));
  }
  for (const r of toUpsert.recipes) {
    batch.push(p(`INSERT INTO recipes (user_id, id, name, yield, packaging_per_unit, labor_total, extra_total, desired_margin, prep_minutes, rev, deleted_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL WHERE ${g('?1', '?11')}
      ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, yield = excluded.yield, packaging_per_unit = excluded.packaging_per_unit, labor_total = excluded.labor_total,
        extra_total = excluded.extra_total, desired_margin = excluded.desired_margin, prep_minutes = excluded.prep_minutes, rev = excluded.rev, deleted_at = NULL`, userId, r.id, r.name, r.yield, r.packagingPerUnit, r.laborTotal, r.extraTotal, r.desiredMargin, r.prepMinutes ?? null, rev, newPushId));
    batch.push(p(`DELETE FROM recipe_items WHERE user_id = ?1 AND recipe_id = ?2 AND ${g('?1', '?3')}`, userId, r.id, newPushId));
    batch.push(p(`INSERT INTO recipe_items (user_id, recipe_id, position, ingredient_id, quantity, unit)
      SELECT ?1, ?2, CAST(j.key AS INTEGER), json_extract(j.value, '$.ingredientId'), json_extract(j.value, '$.quantity'), json_extract(j.value, '$.unit') FROM json_each(?3) AS j WHERE ${g('?1', '?4')}`, userId, r.id, JSON.stringify(r.items), newPushId));
    if (r.packagingItems !== undefined) {
      batch.push(p(`DELETE FROM recipe_packaging_items WHERE user_id=?1 AND recipe_id=?2 AND ${g('?1','?3')}`, userId,r.id,newPushId));
      if (r.packagingItems.length) batch.push(p(`INSERT INTO recipe_packaging_items (user_id,recipe_id,position,packaging_id,quantity_per_unit) SELECT ?1,?2,CAST(j.key AS INTEGER),json_extract(j.value,'$.packagingId'),json_extract(j.value,'$.quantityPerUnit') FROM json_each(?3) j WHERE ${g('?1','?4')}`,userId,r.id,JSON.stringify(r.packagingItems),newPushId));
    }
  }
  for (const o of toUpsert.orders) {
    batch.push(p(`INSERT INTO orders (user_id, id, customer, recipe_id, quantity, unit_price, deposit, delivery_date, status, created_at, cost_per_unit, cost_captured_at, quote_code, rev, deleted_at, packaging_items_json, cost_snapshot_packaging_json, packaging_charge)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?15, ?13, NULL, ?16, ?17, COALESCE(?18, 0) WHERE ${g('?1', '?14')}
      ON CONFLICT (user_id, id) DO UPDATE SET customer = excluded.customer, recipe_id = excluded.recipe_id, quantity = excluded.quantity, unit_price = excluded.unit_price, deposit = excluded.deposit,
        delivery_date = excluded.delivery_date, status = excluded.status, created_at = excluded.created_at, cost_per_unit = excluded.cost_per_unit, cost_captured_at = excluded.cost_captured_at, quote_code = COALESCE(orders.quote_code, excluded.quote_code), rev = excluded.rev, deleted_at = NULL, packaging_items_json=excluded.packaging_items_json, cost_snapshot_packaging_json=excluded.cost_snapshot_packaging_json, packaging_charge=CASE WHEN ?18 IS NULL THEN orders.packaging_charge ELSE excluded.packaging_charge END`,
      userId, o.id, o.customer, o.recipeId, o.quantity, o.unitPrice, o.deposit, o.deliveryDate, o.status, o.createdAt, o.costSnapshot?.costPerUnit ?? null, o.costSnapshot?.capturedAt ?? null, rev, newPushId, o.quoteCode ?? null, JSON.stringify(o.packagingItems ?? []), JSON.stringify(o.costSnapshot?.packagingItems ?? []), o.packagingCharge ?? null));
    batch.push(p(`DELETE FROM order_payments WHERE user_id = ?1 AND order_id = ?2 AND ${g('?1', '?3')}`, userId, o.id, newPushId));
    if (o.payments?.length) batch.push(p(`INSERT INTO order_payments (user_id, order_id, position, id, amount, received_at, method, note)
      SELECT ?1, ?2, CAST(j.key AS INTEGER), json_extract(j.value, '$.id'), json_extract(j.value, '$.amount'), json_extract(j.value, '$.receivedAt'), json_extract(j.value, '$.method'), json_extract(j.value, '$.note') FROM json_each(?3) AS j WHERE ${g('?1', '?4')}`, userId, o.id, JSON.stringify(o.payments), newPushId));
  }
  for (const id of toDelete.ingredients) batch.push(p(`UPDATE ingredients SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
  for (const id of toDelete.recipes) {
    batch.push(p(`UPDATE recipes SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
    batch.push(p(`DELETE FROM recipe_items WHERE user_id = ?1 AND recipe_id = ?2 AND ${g('?1', '?3')}`, userId, id, newPushId));
  }
  for (const id of toDelete.orders) {
    batch.push(p(`UPDATE orders SET deleted_at = ?3, rev = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL AND ${g('?1', '?5')}`, userId, id, now, rev, newPushId));
    batch.push(p(`DELETE FROM order_payments WHERE user_id = ?1 AND order_id = ?2 AND ${g('?1', '?3')}`, userId, id, newPushId));
  }
  for (const id of toDelete.packagings) batch.push(p(`UPDATE packagings SET deleted_at=?3, rev=?4 WHERE user_id=?1 AND id=?2 AND deleted_at IS NULL AND ${g('?1','?5')}`,userId,id,now,rev,newPushId));
  if (settingsChanged && settings) batch.push(p('UPDATE sync_state SET settings_json = ?2, settings_rev = ?3 WHERE user_id = ?1 AND last_push_id = ?4', userId, JSON.stringify(settings), rev, newPushId));

  let results: Awaited<ReturnType<D1Like['batch']>>;
  try { results = await db.batch(batch); }
  catch (error) {
    // Corrida rara: outro envio gravou o mesmo código entre a conferência e a gravação. Nada foi aplicado; o app repete e a conferência acusa o código.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return bad(409, { error: 'STALE', revision: (await getState(db, userId, now)).revision });
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) return bad(409, { error: 'STALE', revision: (await getState(db, userId, now)).revision }); // outro envio ganhou a corrida; nada foi aplicado
  return { ok: true, result: { revision: rev, changed: true } };
}
