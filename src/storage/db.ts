import { CURRENT_SCHEMA_VERSION, type DataSet } from '../domain/types';
import { migrateStored, upgradeOrderShape, validateDataSet } from '../../shared/dataset';
import { withQuoteCodes } from '../../shared/quoteCode';
import { emptyMeta, type SyncMeta } from '../sync/engine';
/** Encomendas antigas (sem código de atendimento) recebem o código derivado do id; só esse campo é acrescentado (valores e recebimentos não mudam). */
export const withCodes = (d: DataSet): DataSet => { const orders = withQuoteCodes(d.orders); return orders === d.orders ? d : { ...d, orders }; };
export const emptyData = (): DataSet => ({ schemaVersion: CURRENT_SCHEMA_VERSION, ingredients: [], recipes: [], orders: [], packagings: [] });
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
    request.onsuccess = () => resolve(request.result ? withCodes(migrateStored(request.result)) : emptyData());
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
/**
 * Versão do documento de dados (chave `dataVersion`, ao lado de `data`). Cada gravação aceita soma 1. Serve para uma gravação COMPARAR-E-TROCAR
 * dentro da mesma transação do IndexedDB (que o navegador serializa entre abas): quem gravou por último não apaga o que outra aba gravou antes.
 */
export class StaleWriteError extends Error { constructor() { super('Os dados foram alterados em outra aba.'); this.name = 'StaleWriteError'; } }
export async function loadDataVersioned(): Promise<{ data: DataSet; version: number }> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE); const d = store.get('data'), v = store.get('dataVersion');
    tx.oncomplete = () => { db.close(); resolve({ data: d.result ? withCodes(migrateStored(d.result)) : emptyData(), version: typeof v.result === 'number' ? v.result : 0 }); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export async function readDataVersion(): Promise<number> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly'); const v = tx.objectStore(STORE).get('dataVersion');
    tx.oncomplete = () => { db.close(); resolve(typeof v.result === 'number' ? v.result : 0); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
/** Grava os dados SÓ SE a versão gravada ainda for `expected` (lê e grava na MESMA transação). Devolve a nova versão; recusa com StaleWriteError se outra aba gravou antes. */
export async function saveDataCas(data: DataSet, expected: number): Promise<number> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE); let next = expected, stale = false;
    const get = store.get('dataVersion');
    get.onsuccess = () => {
      const current = typeof get.result === 'number' ? get.result : 0;
      if (current !== expected) { stale = true; return; } // nada é gravado
      next = current + 1; store.put(data, 'data'); store.put(next, 'dataVersion');
    };
    tx.oncomplete = () => { db.close(); if (stale) reject(new StaleWriteError()); else resolve(next); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('gravação cancelada')); };
  });
}
export async function saveData(data: DataSet): Promise<void> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'); const store = tx.objectStore(STORE);
    const get = store.get('dataVersion');
    get.onsuccess = () => { store.put(data, 'data'); store.put((typeof get.result === 'number' ? get.result : 0) + 1, 'dataVersion'); }; // gravação sem comparação (testes/importações): também avança a versão
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
/** Validação estrita de backups importados. Nada é restaurado se algo estiver inválido. */
export const validateBackup = (value: unknown): DataSet => withCodes(validateDataSet(value));

/** Metadados da sincronização (revisões e último estado do servidor), guardados à parte dos dados do usuário. */
export async function loadSyncMeta(): Promise<SyncMeta> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get('sync');
    request.onsuccess = () => { const v = request.result as Partial<SyncMeta> | undefined; resolve(v && typeof v.revision === 'number' && v.baseline && v.revs ? migrateMeta({ ...emptyMeta(), ...v, revs: { ...emptyMeta().revs, ...v.revs, packagings: v.revs.packagings ?? {} } } as SyncMeta) : emptyMeta()); };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
/**
 * Metadados gravados antes das encomendas com itens: a base e os conflitos guardam encomendas no formato antigo.
 * Converte com a MESMA regra dos dados (`upgradeOrderShape`), para a comparação local × base × nuvem continuar exata.
 */
export function migrateMeta(meta: SyncMeta): SyncMeta {
  const order = (v: unknown) => (v === null || v === undefined ? v : upgradeOrderShape(v));
  return { ...meta, baseline: { ...migrateStored(meta.baseline), ...(meta.baseline.settings ? { settings: meta.baseline.settings } : {}) },
    conflicts: meta.conflicts.map(c => (c.kind !== 'orders' ? c : { ...c, local: order(c.local), server: order(c.server), ...(c.base !== undefined ? { base: order(c.base) } : {}) })) };
}
export async function saveSyncMeta(meta: SyncMeta): Promise<void> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(meta, 'sync');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
