import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSet } from '../src/domain/types';
import { emptyData, loadData, loadDataVersioned, readDataVersion, saveData, saveDataCas, StaleWriteError } from '../src/storage/db';

const ds = (price: number): DataSet => ({ ...emptyData(), ingredients: [{ id: 'a', name: 'A', unit: 'g', purchaseQuantity: 1, purchasePrice: price }] });
beforeEach(() => { (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); });

describe('Gravação comparar-e-trocar (compare-and-swap) no IndexedDB', () => {
  it('banco novo ou documento antigo (sem versão) começa na versão 0 e a primeira gravação passa', async () => {
    expect((await loadDataVersioned()).version).toBe(0); expect(await saveDataCas(ds(1), 0)).toBe(1); expect((await loadDataVersioned()).version).toBe(1);
  });
  it('grava só se a versão ainda for a que a aba leu; senão recusa e NÃO toca no disco', async () => {
    await saveDataCas(ds(1), 0);                                           // aba A (versão 1)
    await expect(saveDataCas(ds(99), 0)).rejects.toBeInstanceOf(StaleWriteError); // aba B ainda acha que está na versão 0
    expect((await loadData()).ingredients[0].purchasePrice).toBe(1); expect(await readDataVersion()).toBe(1);
  });
  it('duas gravações SIMULTÂNEAS com a mesma versão: exatamente uma vence, a outra é recusada (o navegador serializa as transações)', async () => {
    await saveDataCas(ds(1), 0);
    const results = await Promise.allSettled([saveDataCas(ds(10), 1), saveDataCas(ds(20), 1), saveDataCas(ds(30), 1)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(2);
    const won = results.findIndex(r => r.status === 'fulfilled'); expect((await loadData()).ingredients[0].purchasePrice).toBe([10, 20, 30][won]); expect(await readDataVersion()).toBe(2);
  });
  it('a versão avança a cada gravação aceita, e a gravação sem comparação (importações/testes) também avança', async () => {
    let v = 0; for (let i = 0; i < 5; i++) v = await saveDataCas(ds(i), v); expect(v).toBe(5);
    await saveData(ds(50)); expect(await readDataVersion()).toBe(6);
    await expect(saveDataCas(ds(1), 5)).rejects.toBeInstanceOf(StaleWriteError); // quem gravou sem comparar também protege os outros
  });
  it('dados e versão são gravados juntos (uma transação): nunca um sem o outro', async () => {
    await saveDataCas(ds(7), 0); const { data, version } = await loadDataVersioned(); expect([data.ingredients[0].purchasePrice, version]).toEqual([7, 1]);
  });
});
