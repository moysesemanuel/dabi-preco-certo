import { CURRENT_SCHEMA_VERSION, type DataSet } from '../domain/types';
import { migrateStored, validateDataSet } from '../../shared/dataset';
import { withQuoteCodes } from '../../shared/quoteCode';
import { emptyMeta, type SyncMeta } from '../sync/engine';
/** Encomendas antigas (sem código de atendimento) recebem o código derivado do id; só esse campo é acrescentado (valores e recebimentos não mudam). */
export const withCodes = (d: DataSet): DataSet => { const orders = withQuoteCodes(d.orders); return orders === d.orders ? d : { ...d, orders }; };
export const emptyData = (): DataSet => ({ schemaVersion: CURRENT_SCHEMA_VERSION, ingredients: [], recipes: [], orders: [] });
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
export async function saveData(data: DataSet): Promise<void> {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, 'data');
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
    request.onsuccess = () => { const v = request.result as Partial<SyncMeta> | undefined; resolve(v && typeof v.revision === 'number' && v.baseline && v.revs ? { ...emptyMeta(), ...v } as SyncMeta : emptyMeta()); };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
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
