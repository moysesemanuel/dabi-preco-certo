/**
 * Validação estrita e migração do conjunto de dados do app (backup e, no servidor, sincronização).
 * Sem dependências de DOM. Lança Error com mensagem em português; nunca devolve dados parcialmente válidos.
 *
 * Política de migração:
 *  - v1 → v2 → v3: nada é inventado (v3 só acrescenta `payments` opcional).
 *  - v4 → v5: a encomenda de UMA receita (`recipeId`, `quantity`, `unitPrice`, `costSnapshot`) vira um item com id fixo
 *    (`LEGACY_ITEM_ID`), sem nome registrado e com o mesmo custo histórico (ou nenhum). A conversão é determinística: dois
 *    aparelhos e o servidor chegam ao mesmo item, sem gerar conflito. Status, sinal e recebimentos não mudam.
 *  - v1 → v2: nada é inventado. Encomendas antigas continuam SEM `costSnapshot`; o app as trata como custo "estimado".
 *  - Dados já gravados no navegador são migrados de forma tolerante (`migrateStored`), para nunca tornar dados antigos ilegíveis.
 *  - Backups importados e payloads de sincronização passam por `validateDataSet` (estrito).
 */
import { CURRENT_SCHEMA_VERSION, PAYMENT_METHODS, type CatalogRef, type CostSnapshot, type DataSet, type Ingredient, type Order, type OrderItem, type Packaging, type Payment, type Recipe, type RecipeItem, type RecipePackagingSnapshot, type Settings } from '../src/domain/types';
import { isCentMoney, isPositiveQuantity, toCents2 } from '../src/domain/money';
import { calculateOrderFinancials } from '../src/domain/orderFinancials';
import { isQuoteCode } from './quoteCode';

export const DATASET_LIMITS = { ingredients: 5_000, recipes: 5_000, packagings: 5_000, itemsPerRecipe: 200, packagingItemsPerRecipe: 100, packagingItemsPerOrder: 100, itemsPerOrder: 50, orders: 20_000, paymentsPerOrder: 100, text: 120, note: 200, idLength: 64 } as const;
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

/** Id do item criado a partir de uma encomenda antiga (de uma receita só). Fixo para que a conversão seja igual em todo lugar. */
export const LEGACY_ITEM_ID = 'item-1';
const LEGACY_ORDER_KEYS = ['recipeId', 'quantity', 'unitPrice', 'costSnapshot'] as const;
/**
 * Converte o formato antigo de encomenda (uma receita) para o formato com `items`. Não valida nem inventa nada:
 * só move os campos existentes para dentro de um item. Encomendas que já têm `items` só perdem os campos antigos, se houver.
 */
export function upgradeOrderShape(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const legacy = LEGACY_ORDER_KEYS.some(k => k in raw);
  if (!legacy) return raw;
  const { recipeId, quantity, unitPrice, costSnapshot, ...rest } = raw;
  if (Array.isArray(rest.items)) return rest;
  return { ...rest, items: [{ id: LEGACY_ITEM_ID, recipeId, quantity, unitPrice, ...(costSnapshot !== undefined ? { costSnapshot } : {}) }] };
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
    orders: arr<unknown>(o.orders).map(upgradeOrderShape) as Order[],
    packagings: arr<Packaging>(o.packagings),
  };
}

const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Referência do catálogo de medidas. Validada só pela forma: o catálogo pode mudar de versão sem invalidar dados antigos. */
export function parseCatalogRef(raw: unknown): CatalogRef {
  if (!isObj(raw)) return fail('Referência de medidas inválida.');
  if (typeof raw.id !== 'string' || !CATALOG_ID.test(raw.id) || typeof raw.variant !== 'string' || !CATALOG_ID.test(raw.variant)) return fail('Referência de medidas inválida (identificador).');
  if (typeof raw.version !== 'string' || !/^[0-9A-Za-z.\-]{1,24}$/.test(raw.version)) return fail('Referência de medidas inválida (versão).');
  if (!optPositive(raw.densityGPerMl) || !optPositive(raw.gramsPerUnit)) return fail('Referência de medidas inválida (valores).');
  return { id: raw.id, variant: raw.variant, version: raw.version, ...(raw.densityGPerMl !== undefined ? { densityGPerMl: raw.densityGPerMl as number } : {}), ...(raw.gramsPerUnit !== undefined ? { gramsPerUnit: raw.gramsPerUnit as number } : {}) };
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
  if (!isCentMoney(v.purchasePrice)) return fail(`${at}: preço inválido; use no máximo duas casas decimais.`);
  if (!optPositive(v.densityGPerMl) || !optPositive(v.gramsPerUnit)) return fail(`${at}: equivalência inválida.`);
  return { id: v.id, name: v.name.trim(), unit: v.unit as Ingredient['unit'], purchaseQuantity: v.purchaseQuantity, purchasePrice: v.purchasePrice,
    ...(v.densityGPerMl !== undefined ? { densityGPerMl: v.densityGPerMl as number } : {}), ...(v.gramsPerUnit !== undefined ? { gramsPerUnit: v.gramsPerUnit as number } : {}),
    ...(v.catalogRef !== undefined ? { catalogRef: parseCatalogRef(v.catalogRef) } : {}) };
}

function recipeOf(r: unknown, n: number, seen: Set<string>, ingredientIds: Set<string>, packagingIds: Set<string>): Recipe {
  const at = `Receita inválida no backup (#${n + 1})`;
  if (!isObj(r)) return fail(`${at}: formato incorreto.`);
  if (typeof r.id !== 'string' || !ID.test(r.id)) return fail(`${at}: identificador inválido.`);
  if (seen.has(r.id)) return fail(`${at}: identificador duplicado "${r.id}".`);
  seen.add(r.id);
  if (!text(r.name)) return fail(`${at}: nome ausente ou longo demais.`);
  if (!isPositiveQuantity(r.yield)) return fail(`${at}: rendimento inválido.`);
  if (typeof r.desiredMargin !== 'number' || !Number.isFinite(r.desiredMargin) || r.desiredMargin < 0 || r.desiredMargin >= 100) return fail(`${at}: margem deve ficar entre 0 e menos de 100.`);
  if (![r.packagingPerUnit, r.laborTotal, r.extraTotal].every(isCentMoney)) return fail(`${at}: custo inválido (use no máximo duas casas decimais).`);
  if (!Array.isArray(r.items) || r.items.length > DATASET_LIMITS.itemsPerRecipe) return fail(`${at}: lista de ingredientes inválida.`);
  const items: RecipeItem[] = r.items.map((it: unknown, k: number) => {
    if (!isObj(it) || typeof it.ingredientId !== 'string') return fail(`${at}: item ${k + 1} inválido.`);
    if (!ingredientIds.has(it.ingredientId)) return fail(`${at}: item ${k + 1} aponta para um ingrediente inexistente.`);
    if (typeof it.quantity !== 'number' || !Number.isFinite(it.quantity) || it.quantity < 0 || it.quantity > 1e9) return fail(`${at}: item ${k + 1} com quantidade inválida.`);
    if (it.unit !== undefined && (typeof it.unit !== 'string' || !MEASURES.includes(it.unit))) return fail(`${at}: item ${k + 1} com medida inválida.`);
    return { ingredientId: it.ingredientId, quantity: it.quantity, ...(it.unit !== undefined ? { unit: it.unit as RecipeItem['unit'] } : {}) };
  });
  if (r.prepMinutes !== undefined && (typeof r.prepMinutes !== 'number' || !Number.isFinite(r.prepMinutes) || r.prepMinutes <= 0 || r.prepMinutes > 10_080)) return fail(`${at}: tempo de produção inválido.`);
  let packagingItems: Recipe['packagingItems'];
  if (r.packagingItems !== undefined) {
    if (!Array.isArray(r.packagingItems) || r.packagingItems.length > DATASET_LIMITS.packagingItemsPerRecipe) return fail(`${at}: embalagens associadas inválidas.`);
    const used = new Set<string>();
    packagingItems = r.packagingItems.map((raw: unknown) => {
      if (!isObj(raw) || typeof raw.packagingId !== 'string' || !packagingIds.has(raw.packagingId) || used.has(raw.packagingId) || typeof raw.quantityPerUnit !== 'number' || !Number.isFinite(raw.quantityPerUnit) || raw.quantityPerUnit <= 0 || raw.quantityPerUnit > 1e9) return fail(`${at}: embalagem associada inválida ou inexistente.`);
      used.add(raw.packagingId); return { packagingId: raw.packagingId, quantityPerUnit: raw.quantityPerUnit };
    });
  }
  return { id: r.id, name: r.name.trim(), yield: r.yield, items, ...(packagingItems ? { packagingItems } : {}), packagingPerUnit: r.packagingPerUnit as number, laborTotal: r.laborTotal as number, extraTotal: r.extraTotal as number, desiredMargin: r.desiredMargin, ...(r.prepMinutes !== undefined ? { prepMinutes: r.prepMinutes } : {}) };
}

function costSnapshotOf(c: unknown, packagingIds: Set<string>, at: string): CostSnapshot {
  if (!isObj(c) || !isMoney(c.costPerUnit) || !isIsoDateTime(c.capturedAt) || (c.packagingItems !== undefined && !Array.isArray(c.packagingItems))) return fail(`${at}: custo registrado inválido.`);
  return { costPerUnit: c.costPerUnit, capturedAt: c.capturedAt, ...(Array.isArray(c.packagingItems) ? { packagingItems: parseRecipePackagingSnapshots(c.packagingItems, packagingIds, at) } : {}) };
}

function orderItemsOf(raw: unknown, recipeIds: Set<string>, packagingIds: Set<string>, at: string): OrderItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(`${at}: a encomenda precisa ter pelo menos um produto.`);
  if (raw.length > DATASET_LIMITS.itemsPerOrder) return fail(`${at}: produtos demais na encomenda.`);
  const ids = new Set<string>();
  return raw.map((item: unknown, k: number): OrderItem => {
    const where = `${at}, produto ${k + 1}`;
    if (!isObj(item)) return fail(`${where}: formato incorreto.`);
    if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) return fail(`${where}: identificador inválido ou repetido.`);
    ids.add(item.id);
    if (typeof item.recipeId !== 'string' || !recipeIds.has(item.recipeId)) return fail(`${where}: aponta para uma receita inexistente.`);
    if (item.recipeName !== undefined && !text(item.recipeName)) return fail(`${where}: nome da receita inválido.`);
    if (!isPositiveQuantity(item.quantity)) return fail(`${at}: quantidade inválida.`);
    if (!isCentMoney(item.unitPrice)) return fail(`${at}: preço inválido; use no máximo duas casas decimais.`);
    return { id: item.id, recipeId: item.recipeId, ...(item.recipeName !== undefined ? { recipeName: (item.recipeName as string).trim() } : {}), quantity: item.quantity, unitPrice: item.unitPrice,
      ...(item.costSnapshot !== undefined ? { costSnapshot: costSnapshotOf(item.costSnapshot, packagingIds, where) } : {}) };
  });
}

function orderOf(raw: unknown, n: number, seen: Set<string>, recipeIds: Set<string>, packagingIds: Set<string>): Order {
  const at = `Encomenda inválida no backup (#${n + 1})`;
  const o = upgradeOrderShape(raw);
  if (!isObj(o)) return fail(`${at}: formato incorreto.`);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return fail(`${at}: identificador inválido.`);
  if (seen.has(o.id)) return fail(`${at}: identificador duplicado "${o.id}".`);
  seen.add(o.id);
  if (!text(o.customer)) return fail(`${at}: cliente ausente ou longo demais.`);
  const items = orderItemsOf(o.items, recipeIds, packagingIds, at);
  if (!isCentMoney(o.deposit)) return fail(`${at}: preço ou sinal inválido; use no máximo duas casas decimais.`);
  const packagingCharge = o.packagingCharge === undefined ? 0 : o.packagingCharge;
  if (!isCentMoney(packagingCharge)) return fail(`${at}: cobrança de embalagens inválida; use no máximo duas casas decimais.`);
  const orderTotal = calculateOrderFinancials({ items, packagingCharge }).totalCharged;
  if (orderTotal > 1_000_000_000) return fail(`${at}: total grande demais.`);
  if (o.deposit > orderTotal) return fail(`${at}: sinal maior que o total.`);
  if (!isIsoDate(o.deliveryDate)) return fail(`${at}: data de entrega inválida.`);
  if (!isIsoDateTime(o.createdAt)) return fail(`${at}: data de criação inválida.`);
  if (typeof o.status !== 'string' || !STATUSES.includes(o.status)) return fail(`${at}: status inválido.`);
  if (o.quoteCode !== undefined && !isQuoteCode(o.quoteCode)) return fail(`${at}: código do orçamento inválido.`);
  let payments: Payment[] | undefined;
  if (o.payments !== undefined) {
    if (!Array.isArray(o.payments) || o.payments.length > DATASET_LIMITS.paymentsPerOrder) return fail(`${at}: lista de recebimentos inválida.`);
    const paymentIds = new Set<string>();
    const parsed = o.payments.map((p: unknown, k: number): Payment => {
      if (!isObj(p) || typeof p.id !== 'string' || !ID.test(p.id) || paymentIds.has(p.id)) return fail(`${at}: recebimento ${k + 1} com identificador inválido ou repetido.`);
      paymentIds.add(p.id);
      if (!isCentMoney(p.amount) || p.amount <= 0) return fail(`${at}: recebimento ${k + 1} com valor inválido.`);
      if (!isIsoDate(p.receivedAt)) return fail(`${at}: recebimento ${k + 1} com data inválida.`);
      if (p.method !== undefined && !(PAYMENT_METHODS as readonly string[]).includes(p.method as string)) return fail(`${at}: recebimento ${k + 1} com meio de pagamento inválido.`);
      if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > DATASET_LIMITS.note)) return fail(`${at}: recebimento ${k + 1} com observação inválida.`);
      return { id: p.id, amount: p.amount, receivedAt: p.receivedAt, ...(p.method !== undefined ? { method: p.method as Payment['method'] } : {}), ...(typeof p.note === 'string' && p.note.trim() ? { note: p.note.trim() } : {}) };
    });
    const received = toCents2(o.deposit + parsed.reduce((s2, p) => s2 + p.amount, 0));
    if (received > orderTotal) return fail(`${at}: o total recebido é maior que o total da encomenda.`);
    if (parsed.length) payments = parsed;
  }
  if (o.packagingItems !== undefined && !Array.isArray(o.packagingItems)) return fail(`${at}: lista de embalagens adicionais inválida.`);
  return { id: o.id, customer: o.customer.trim(), items, deposit: o.deposit, deliveryDate: o.deliveryDate, status: o.status as Order['status'], createdAt: o.createdAt, ...(o.packagingCharge !== undefined ? { packagingCharge } : {}), ...(Array.isArray(o.packagingItems) ? { packagingItems: parseOrderPackaging(o.packagingItems, packagingIds, at) } : {}), ...(payments ? { payments } : {}), ...(o.quoteCode !== undefined ? { quoteCode: o.quoteCode as string } : {}) };
}

function isMoney(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000; }
function parseOrderPackaging(raw: unknown[], packagingIds: Set<string>, at: string) {
  if (raw.length > DATASET_LIMITS.packagingItemsPerOrder) return fail(`${at}: lista de embalagens da encomenda inválida.`);
  return raw.map((entry: unknown) => {
    if (!isObj(entry) || typeof entry.packagingId !== 'string' || !packagingIds.has(entry.packagingId) || !text(entry.name) || typeof entry.quantity !== 'number' || !Number.isFinite(entry.quantity) || entry.quantity <= 0 || !isMoney(entry.unitCost)) return fail(`${at}: snapshot de embalagem inválido.`);
    return { packagingId: entry.packagingId, name: entry.name.trim(), quantity: entry.quantity, unitCost: entry.unitCost };
  });
}
function parseRecipePackagingSnapshots(raw: unknown[], packagingIds: Set<string>, at: string): RecipePackagingSnapshot[] {
  if (raw.length > DATASET_LIMITS.packagingItemsPerRecipe) return fail(`${at}: snapshot de embalagens da receita inválido.`);
  return raw.map((entry: unknown) => {
    if (!isObj(entry) || typeof entry.packagingId !== 'string' || !packagingIds.has(entry.packagingId) || !text(entry.name) || typeof entry.quantityPerUnit !== 'number' || !Number.isFinite(entry.quantityPerUnit) || entry.quantityPerUnit <= 0 || !isMoney(entry.unitCost)) return fail(`${at}: snapshot de embalagem da receita inválido.`);
    return { packagingId: entry.packagingId, name: entry.name.trim(), quantityPerUnit: entry.quantityPerUnit, unitCost: entry.unitCost };
  });
}

/** Validação estrita (backup e sincronização). Aceita versões 1 a 5 e devolve sempre a versão atual. */
export function validateDataSet(value: unknown): DataSet {
  if (!isObj(value)) return fail('Arquivo de backup inválido.');
  if (![1, 2, 3, 4, CURRENT_SCHEMA_VERSION].includes(value.schemaVersion as number) || !Array.isArray(value.ingredients) || !Array.isArray(value.recipes) || !Array.isArray(value.orders) || (value.packagings !== undefined && !Array.isArray(value.packagings))) return fail('Formato de backup incompatível.');
  if (value.ingredients.length > DATASET_LIMITS.ingredients || value.recipes.length > DATASET_LIMITS.recipes || value.orders.length > DATASET_LIMITS.orders || (value.packagings?.length ?? 0) > DATASET_LIMITS.packagings) return fail('Backup grande demais para este aplicativo.');

  const ingredientIds = new Set<string>(), recipeIds = new Set<string>(), orderIds = new Set<string>(), packagingIds = new Set<string>();
  const ingredients = value.ingredients.map((i, n) => ingredientOf(i, n, ingredientIds));
  const packagings: Packaging[] = (value.packagings ?? []).map((p: unknown, n: number) => {
    if (!isObj(p) || typeof p.id !== 'string' || !ID.test(p.id) || packagingIds.has(p.id) || !text(p.name) || !isCentMoney(p.purchasePrice) || !isPositiveQuantity(p.purchaseQuantity) || (p.capacity !== undefined && !isPositiveQuantity(p.capacity)) || (p.active !== undefined && typeof p.active !== 'boolean')) return fail(`Embalagem inválida no backup (#${n + 1}).`);
    packagingIds.add(p.id); return { id: p.id, name: p.name.trim(), purchasePrice: p.purchasePrice, purchaseQuantity: p.purchaseQuantity, ...(p.capacity !== undefined ? { capacity: p.capacity } : {}), active: p.active !== false };
  });
  const recipes = value.recipes.map((r, n) => recipeOf(r, n, recipeIds, ingredientIds, packagingIds));
  const orders = value.orders.map((o, n) => orderOf(o, n, orderIds, recipeIds, packagingIds));
  const codes = new Set<string>();
  for (const o of orders) { if (!o.quoteCode) continue; if (codes.has(o.quoteCode)) return fail(`Código de orçamento repetido no backup: ${o.quoteCode}.`); codes.add(o.quoteCode); }

  const result: DataSet = { schemaVersion: CURRENT_SCHEMA_VERSION, ingredients, recipes, orders, packagings };
  if (value.settings !== undefined) {
    try { result.settings = parseSettings(value.settings); } catch { return fail('Configurações inválidas no backup.'); }
  }
  return result;
}

// ---- Validadores por entidade (usados pela sincronização no servidor; mesmas regras do backup) ----
export const parseIngredient = (raw: unknown): Ingredient => ingredientOf(raw, 0, new Set());
export const parsePackaging = (raw: unknown): Packaging => {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || !text(raw.name) || !isCentMoney(raw.purchasePrice) || !isPositiveQuantity(raw.purchaseQuantity) || (raw.capacity !== undefined && !isPositiveQuantity(raw.capacity)) || (raw.active !== undefined && typeof raw.active !== 'boolean')) return fail('Embalagem inválida.');
  return { id: raw.id, name: raw.name.trim(), purchasePrice: raw.purchasePrice, purchaseQuantity: raw.purchaseQuantity, ...(raw.capacity !== undefined ? { capacity: raw.capacity as number } : {}), active: raw.active !== false };
};
export const parseRecipe = (raw: unknown, ingredientIds: Set<string>, packagingIds: Set<string> = new Set()): Recipe => recipeOf(raw, 0, new Set(), ingredientIds, packagingIds);
export const parseOrder = (raw: unknown, recipeIds: Set<string>, packagingIds: Set<string> = new Set()): Order => orderOf(raw, 0, new Set(), recipeIds, packagingIds);
export function parseSettings(raw: unknown): Settings {
  if (!isObj(raw) || typeof raw.cupSizeMl !== 'number' || !Number.isFinite(raw.cupSizeMl) || raw.cupSizeMl <= 0 || raw.cupSizeMl > 1000) return fail('Configurações inválidas.');
  const out: Settings = { cupSizeMl: raw.cupSizeMl };
  if (raw.businessName !== undefined) {
    if (typeof raw.businessName !== 'string' || raw.businessName.trim().length > 80) return fail('Configurações inválidas: nome do negócio.');
    if (raw.businessName.trim()) out.businessName = raw.businessName.trim().normalize('NFC');
  }
  if (raw.businessPhone !== undefined) {
    if (typeof raw.businessPhone !== 'string' || (raw.businessPhone !== '' && !/^\d{10,15}$/.test(raw.businessPhone))) return fail('Configurações inválidas: telefone do negócio.');
    if (raw.businessPhone) out.businessPhone = raw.businessPhone;
  }
  if (raw.dailyCapacityMinutes !== undefined) {
    if (typeof raw.dailyCapacityMinutes !== 'number' || !Number.isInteger(raw.dailyCapacityMinutes) || raw.dailyCapacityMinutes < 0 || raw.dailyCapacityMinutes > 1440) return fail('Configurações inválidas: capacidade diária.');
    out.dailyCapacityMinutes = raw.dailyCapacityMinutes;
  }
  if (raw.workWeekdays !== undefined) {
    const w = raw.workWeekdays;
    if (!Array.isArray(w) || w.length < 1 || w.length > 7 || !w.every(d => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(w).size !== w.length) return fail('Configurações inválidas: dias de trabalho.');
    out.workWeekdays = [...(w as number[])].sort((a, b) => a - b);
  }
  return out;
}
