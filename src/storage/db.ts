import { CURRENT_SCHEMA_VERSION, type DataSet } from '../domain/types';
import { migrateStored, validateDataSet } from '../../shared/dataset';
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
    request.onsuccess = () => resolve(request.result ? migrateStored(request.result) : emptyData());
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
export const validateBackup = (value: unknown): DataSet => validateDataSet(value);
