/**
 * Validação estrita e migração do conjunto de dados do app (backup e, no servidor, sincronização).
 * Sem dependências de DOM. Lança Error com mensagem em português; nunca devolve dados parcialmente válidos.
 *
 * Política de migração:
 *  - v1 → v2: nada é inventado. Encomendas antigas continuam SEM `costSnapshot`; o app as trata como custo "estimado".
 *  - Dados já gravados no navegador são migrados de forma tolerante (`migrateStored`), para nunca tornar dados antigos ilegíveis.
 *  - Backups importados e payloads de sincronização passam por `validateDataSet` (estrito).
 */
import { CURRENT_SCHEMA_VERSION, type CostSnapshot, type DataSet, type Ingredient, type Order, type Recipe, type RecipeItem } from '../src/domain/types';
import { isMoney, isPositiveQuantity } from '../src/domain/money';

export const DATASET_LIMITS = { ingredients: 5_000, recipes: 5_000, itemsPerRecipe: 200, orders: 20_000, text: 120, idLength: 64 } as const;
export { CURRENT_SCHEMA_VERSION };

const UNITS = ['g', 'kg', 'ml', 'l', 'un'];
const MEASURES = [...UNITS, 'xic', 'cs', 'cc'];
const STATUSES = ['Orçamento', 'Confirmado', 'Produção', 'Entregue'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= DATASET_LIMITS.text;
const optPositive = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0);

/** Data AAAA-MM-DD real. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
/** Data e hora ISO 8601 em UTC (ex.: 2026-11-11T10:00:00Z ou .000Z). */
export const isIsoDateTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v)) && isIsoDate(v.slice(0, 10));

const fail = (message: string): never => { throw new Error(message); };

/** Versão 1 guardava `gramsPerCup` (g por xícara de 240 mL); hoje guardamos a densidade em g/mL. */
function legacyIngredient(i: Obj): Obj {
  if (typeof i.gramsPerCup !== 'number') return i;
  const { gramsPerCup, ...rest } = i;
  return Number.isFinite(gramsPerCup) && gramsPerCup > 0 && rest.densityGPerMl === undefined ? { ...rest, densityGPerMl: gramsPerCup / 240 } : rest;
}

/** Migração TOLERANTE de dados já gravados no navegador: ajusta a versão sem rejeitar nem apagar nada. */
export function migrateStored(raw: unknown): DataSet {
  const o = isObj(raw) ? raw : {};
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...(o as Partial<DataSet>),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ingredients: arr<Obj>(o.ingredients).map(i => (isObj(i) ? legacyIngredient(i) : i)) as unknown as Ingredient[],
    recipes: arr<Recipe>(o.recipes),
    orders: arr<Order>(o.orders),
  };
}

function ingredientOf(i: unknown, n: number, seen: Set<string>): Ingredient {
  const at = `Ingrediente inválido no backup (#${n + 1})`;
  if (!isObj(i)) return fail(`${at}: formato incorreto.`);
  const v = legacyIngredient(i);
  if (typeof v.id !== 'string' || !ID.test(v.id)) return fail(`${at}: identificador inválido.`);
  if (seen.has(v.id)) return fail(`${at}: identificador duplicado "${v.id}".`);
  seen.add(v.id);
  if (!text(v.name)) return fail(`${at}: nome ausente ou longo demais.`);
  if (typeof v.unit !== 'string' || !UNITS.includes(v.unit)) return fail(`${at}: unidade inválida.`);
  if (!isPositiveQuantity(v.purchaseQuantity)) return fail(`${at}: quantidade comprada inválida.`);
  if (!isMoney(v.purchasePrice)) return fail(`${at}: preço inválido.`);
  if (!optPositive(v.densityGPerMl) || !optPositive(v.gramsPerUnit)) return fail(`${at}: equivalência inválida.`);
  return { id: v.id, name: v.name.trim(), unit: v.unit as Ingredient['unit'], purchaseQuantity: v.purchaseQuantity, purchasePrice: v.purchasePrice,
    ...(v.densityGPerMl !== undefined ? { densityGPerMl: v.densityGPerMl as number } : {}), ...(v.gramsPerUnit !== undefined ? { gramsPerUnit: v.gramsPerUnit as number } : {}) };
}

function recipeOf(r: unknown, n: number, seen: Set<string>, ingredientIds: Set<string>): Recipe {
  const at = `Receita inválida no backup (#${n + 1})`;
  if (!isObj(r)) return fail(`${at}: formato incorreto.`);
  if (typeof r.id !== 'string' || !ID.test(r.id)) return fail(`${at}: identificador inválido.`);
  if (seen.has(r.id)) return fail(`${at}: identificador duplicado "${r.id}".`);
  seen.add(r.id);
  if (!text(r.name)) return fail(`${at}: nome ausente ou longo demais.`);
  if (!isPositiveQuantity(r.yield)) return fail(`${at}: rendimento inválido.`);
  if (typeof r.desiredMargin !== 'number' || !Number.isFinite(r.desiredMargin) || r.desiredMargin < 0 || r.desiredMargin >= 100) return fail(`${at}: margem deve ficar entre 0 e menos de 100.`);
  if (![r.packagingPerUnit, r.laborTotal, r.extraTotal].every(isMoney)) return fail(`${at}: custo inválido (embalagem, mão de obra ou extras).`);
  if (!Array.isArray(r.items) || r.items.length > DATASET_LIMITS.itemsPerRecipe) return fail(`${at}: lista de ingredientes inválida.`);
  const items: RecipeItem[] = r.items.map((it: unknown, k: number) => {
    if (!isObj(it) || typeof it.ingredientId !== 'string') return fail(`${at}: item ${k + 1} inválido.`);
    if (!ingredientIds.has(it.ingredientId)) return fail(`${at}: item ${k + 1} aponta para um ingrediente inexistente.`);
    if (typeof it.quantity !== 'number' || !Number.isFinite(it.quantity) || it.quantity < 0 || it.quantity > 1e9) return fail(`${at}: item ${k + 1} com quantidade inválida.`);
    if (it.unit !== undefined && (typeof it.unit !== 'string' || !MEASURES.includes(it.unit))) return fail(`${at}: item ${k + 1} com medida inválida.`);
    return { ingredientId: it.ingredientId, quantity: it.quantity, ...(it.unit !== undefined ? { unit: it.unit as RecipeItem['unit'] } : {}) };
  });
  return { id: r.id, name: r.name.trim(), yield: r.yield, items, packagingPerUnit: r.packagingPerUnit as number, laborTotal: r.laborTotal as number, extraTotal: r.extraTotal as number, desiredMargin: r.desiredMargin };
}

function orderOf(o: unknown, n: number, seen: Set<string>, recipeIds: Set<string>): Order {
  const at = `Encomenda inválida no backup (#${n + 1})`;
  if (!isObj(o)) return fail(`${at}: formato incorreto.`);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return fail(`${at}: identificador inválido.`);
  if (seen.has(o.id)) return fail(`${at}: identificador duplicado "${o.id}".`);
  seen.add(o.id);
  if (!text(o.customer)) return fail(`${at}: cliente ausente ou longo demais.`);
  if (typeof o.recipeId !== 'string' || !recipeIds.has(o.recipeId)) return fail(`${at}: aponta para uma receita inexistente.`);
  if (!isPositiveQuantity(o.quantity)) return fail(`${at}: quantidade inválida.`);
  if (!isMoney(o.unitPrice) || !isMoney(o.deposit)) return fail(`${at}: preço ou sinal inválido.`);
  if (o.deposit > Math.round(o.quantity * o.unitPrice * 100) / 100 + 0.005) return fail(`${at}: sinal maior que o total.`);
  if (!isIsoDate(o.deliveryDate)) return fail(`${at}: data de entrega inválida.`);
  if (!isIsoDateTime(o.createdAt)) return fail(`${at}: data de criação inválida.`);
  if (typeof o.status !== 'string' || !STATUSES.includes(o.status)) return fail(`${at}: status inválido.`);
  let costSnapshot: CostSnapshot | undefined;
  if (o.costSnapshot !== undefined) {
    const c = o.costSnapshot;
    if (!isObj(c) || !isMoney(c.costPerUnit) || !isIsoDateTime(c.capturedAt)) return fail(`${at}: custo registrado inválido.`);
    costSnapshot = { costPerUnit: c.costPerUnit, capturedAt: c.capturedAt };
  }
  return { id: o.id, customer: o.customer.trim(), recipeId: o.recipeId, quantity: o.quantity, unitPrice: o.unitPrice, deposit: o.deposit, deliveryDate: o.deliveryDate, status: o.status as Order['status'], createdAt: o.createdAt, ...(costSnapshot ? { costSnapshot } : {}) };
}

/** Validação estrita (backup e sincronização). Aceita versões 1 e 2 e devolve sempre a versão atual. */
export function validateDataSet(value: unknown): DataSet {
  if (!isObj(value)) return fail('Arquivo de backup inválido.');
  if ((value.schemaVersion !== 1 && value.schemaVersion !== CURRENT_SCHEMA_VERSION) || !Array.isArray(value.ingredients) || !Array.isArray(value.recipes) || !Array.isArray(value.orders)) return fail('Formato de backup incompatível.');
  if (value.ingredients.length > DATASET_LIMITS.ingredients || value.recipes.length > DATASET_LIMITS.recipes || value.orders.length > DATASET_LIMITS.orders) return fail('Backup grande demais para este aplicativo.');

  const ingredientIds = new Set<string>(), recipeIds = new Set<string>(), orderIds = new Set<string>();
  const ingredients = value.ingredients.map((i, n) => ingredientOf(i, n, ingredientIds));
  const recipes = value.recipes.map((r, n) => recipeOf(r, n, recipeIds, ingredientIds));
  const orders = value.orders.map((o, n) => orderOf(o, n, orderIds, recipeIds));

  const result: DataSet = { schemaVersion: CURRENT_SCHEMA_VERSION, ingredients, recipes, orders };
  if (value.settings !== undefined) {
    const s = value.settings;
    if (!isObj(s) || typeof s.cupSizeMl !== 'number' || !Number.isFinite(s.cupSizeMl) || s.cupSizeMl <= 0 || s.cupSizeMl > 1000) return fail('Configurações inválidas no backup.');
    result.settings = { cupSizeMl: s.cupSizeMl };
  }
  return result;
}
