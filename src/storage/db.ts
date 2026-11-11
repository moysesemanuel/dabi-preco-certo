import type { DataSet } from '../domain/types';
export const emptyData = (): DataSet => ({ schemaVersion: 1, ingredients: [], recipes: [], orders: [] });
const DB_NAME = 'pedidocerto-v1';
const STORE = 'app';
function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function loadData(): Promise<DataSet> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get('data');
    request.onsuccess = () => resolve(request.result ?? emptyData());
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
export async function saveData(data: DataSet): Promise<void> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, 'data');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export function validateBackup(value: unknown): DataSet {
  if (typeof value !== 'object' || value === null) throw new Error('Arquivo de backup inválido.');
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.ingredients) || !Array.isArray(obj.recipes) || !Array.isArray(obj.orders)) throw new Error('Formato de backup incompatível.');
  for (const i of obj.ingredients) {
    if (!i || typeof i.id !== 'string' || typeof i.name !== 'string' || !['g','kg','ml','l','un'].includes(i.unit) || !Number.isFinite(i.purchaseQuantity) || i.purchaseQuantity <= 0 || !Number.isFinite(i.purchasePrice) || i.purchasePrice < 0) throw new Error('Ingrediente inválido no backup.');
  }
  for (const r of obj.recipes) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.items) || !Number.isFinite(r.yield) || r.yield <= 0 || !Number.isFinite(r.desiredMargin) || r.desiredMargin < 0 || r.desiredMargin >= 100 || ![r.packagingPerUnit,r.laborTotal,r.extraTotal].every((v:unknown)=>Number.isFinite(v)&&Number(v)>=0) || !r.items.every((i: {ingredientId?:unknown;quantity?:unknown})=>typeof i.ingredientId==='string'&&Number.isFinite(i.quantity)&&Number(i.quantity)>=0)) throw new Error('Receita inválida no backup.');
  }
  for (const o of obj.orders) {
    if (!o || typeof o.id !== 'string' || typeof o.customer !== 'string' || typeof o.recipeId !== 'string' || !Number.isFinite(o.quantity) || o.quantity <= 0 || !Number.isFinite(o.unitPrice) || o.unitPrice < 0 || !Number.isFinite(o.deposit) || o.deposit < 0 || !['Orçamento','Confirmado','Produção','Entregue'].includes(o.status)) throw new Error('Encomenda inválida no backup.');
  }
  return value as DataSet;
}
