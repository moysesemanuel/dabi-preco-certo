import { asOrder } from './helpers/orders';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSet, Ingredient, Order, Recipe } from '../src/domain/types';
import { applyPull, buildPushes, emptyDataSet, emptyMeta, healConflicts, isPendingConflict, isUnresolved, type ConflictRecord } from '../src/sync/engine';
import { loadData, loadSyncMeta, saveData, saveSyncMeta } from '../src/storage/db';
import { diffRows } from '../src/sync/describe';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

// Integração: motor de sincronização real + cliente HTTP + Worker real (SQLite com as migrações reais) + IndexedDB (fake-indexeddb).
let srv: Server;
const device = async (label: string, email = 'bia@exemplo.com') => new Device(srv, await srv.login(email, label));
beforeEach(async () => { srv = makeServer(); await srv.issueFor('bia@exemplo.com'); (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); });

const ing = (id: string, over: Partial<Ingredient> = {}): Ingredient => ({ id, name: id === 'farinha' ? 'Farinha de trigo' : `Ingrediente ${id}`, unit: 'kg', purchaseQuantity: 1, purchasePrice: 11, ...over });
const rec = (id: string, ingredientId: string): Recipe => ({ id, name: `Receita ${id}`, yield: 10, items: [{ ingredientId, quantity: 500, unit: 'g' }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20 });
const ord = (id: string, over: Partial<Order> = {}): Order => asOrder({ id, customer: 'Ana', recipeId: 'r', quantity: 2, unitPrice: 100, deposit: 20, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', ...over });
const data = (p: Partial<DataSet> = {}): DataSet => ({ ...emptyDataSet(), ...p });
const setPrice = (id: string, price: number) => (d: DataSet): DataSet => ({ ...d, ingredients: d.ingredients.map(i => (i.id === id ? { ...i, purchasePrice: price } : i)) });
const price = (d: DataSet, id = 'farinha') => d.ingredients.find(i => i.id === id)?.purchasePrice;
const serverPrice = (id = 'farinha') => srv.table('ingredients').find(r => r.id === id)?.purchase_price;
const pending = (d: Device) => d.meta.conflicts.filter(isPendingConflict);
async function twoDevices(initial: DataSet = data({ ingredients: [ing('farinha')] })) {
  const A = await device('Janela anônima'), B = await device('Janela normal');
  A.edit(() => initial); await A.sync(); await B.sync();
  return { A, B };
}
/** O cenário reproduzido: R$ 11 nos dois; A offline altera para 12; B altera para 13 e sincroniza; A reconecta. */
async function scenario() {
  const { A, B } = await twoDevices();
  expect(price(A.data)).toBe(11); expect(price(B.data)).toBe(11);
  A.offline = true; A.edit(setPrice('farinha', 12)); expect((await A.sync()).status).toBe('offline');
  B.edit(setPrice('farinha', 13)); await B.sync();
  A.offline = false;
  return { A, B, back: await A.sync() };
}

describe('Cenário reproduzido: R$ 11 → A offline R$ 12 / B online R$ 13 → A reconecta', () => {
  it('detecta o conflito, preserva as duas versões e NÃO substitui nem envia nada em silêncio', async () => {
    const { A, back } = await scenario();
    expect(price(A.data)).toBe(12); // a alteração local continua nos dados (antes da correção virava 13 sem aviso)
    expect(serverPrice()).toBe(13); // e a nuvem não foi sobrescrita
    const [c] = pending(A);
    expect(pending(A)).toHaveLength(1);
    expect(c).toMatchObject({ kind: 'ingredients', entityId: 'farinha', reason: 'edited-elsewhere', pending: true });
    expect((c.base as Ingredient).purchasePrice).toBe(11); expect((c.local as Ingredient).purchasePrice).toBe(12); expect((c.server as Ingredient).purchasePrice).toBe(13);
    expect(back.newConflicts).toHaveLength(1);
    expect(A.meta.conflicts.some(isUnresolved)).toBe(true); // o app não pode mostrar "sincronizado"
    expect(buildPushes(A.data, A.meta)).toEqual([]);
  });
  it('a descrição para a tela mostra o campo divergente, os dois valores e a base', async () => {
    const { A } = await scenario();
    expect(diffRows(pending(A)[0])).toEqual([{ key: 'purchasePrice', label: 'Preço', local: expect.stringMatching(/12,00/), server: expect.stringMatching(/13,00/), base: expect.stringMatching(/11,00/) }]);
  });
  it('retries e novos pulls não eliminam nem duplicam o conflito', async () => {
    const { A } = await scenario();
    const id = pending(A)[0].id;
    for (let n = 0; n < 5; n++) await A.sync();
    expect(pending(A).map(c => c.id)).toEqual([id]); expect(price(A.data)).toBe(12); expect(serverPrice()).toBe(13);
  });
  it('manter minha alteração: a nuvem recebe R$ 12 e o outro dispositivo converge', async () => {
    const { A, B } = await scenario();
    A.resolve(pending(A)[0].id, 'keep-local'); expect(A.meta.conflicts[0].pending).toBe(false);
    expect((await A.sync()).status).toBe('synced');
    expect(serverPrice()).toBe(12); await B.sync(); expect(price(B.data)).toBe(12);
    expect(A.meta.conflicts.some(isUnresolved)).toBe(false);
  });
  it('manter a versão da nuvem: local passa a R$ 13 e a versão local fica guardada no histórico', async () => {
    const { A } = await scenario();
    const c = A.resolve(pending(A)[0].id, 'keep-server');
    expect(price(A.data)).toBe(13); expect(c.resolution?.action).toBe('keep-server'); expect((c.local as Ingredient).purchasePrice).toBe(12);
    expect((await A.sync()).status).toBe('synced'); expect(serverPrice()).toBe(13); expect(buildPushes(A.data, A.meta)).toEqual([]);
    expect((A.meta.conflicts[0].local as Ingredient).purchasePrice).toBe(12);
  });
  it('adiar a decisão não perde nada, inclusive depois de "recarregar" (IndexedDB) e reconectar', async () => {
    const { A } = await scenario();
    await saveSyncMeta(A.meta);                                   // o app grava o estado de sincronização a cada ciclo
    const reloaded = await loadSyncMeta();                        // F5: o estado volta do IndexedDB
    expect(reloaded.conflicts).toEqual(A.meta.conflicts);
    A.meta = reloaded; await A.sync(); await A.sync();
    expect(pending(A)).toHaveLength(1); expect(price(A.data)).toBe(12); expect(serverPrice()).toBe(13);
    A.resolve(pending(A)[0].id, 'keep-local'); expect((await A.sync()).status).toBe('synced'); expect(serverPrice()).toBe(12);
  });
  it('a nuvem muda de novo durante a decisão: o conflito é atualizado e a escolha desatualizada é recusada', async () => {
    const { A, B } = await scenario();
    const seen = pending(A)[0].serverRev;
    B.edit(setPrice('farinha', 14)); await B.sync();
    await A.sync();
    expect(pending(A)).toHaveLength(1); expect((pending(A)[0].server as Ingredient).purchasePrice).toBe(14); expect(pending(A)[0].serverRev).not.toBe(seen);
    expect(() => A.resolve(pending(A)[0].id, 'keep-local', seen)).toThrow(/mudou enquanto você decidia/);
    expect(pending(A)).toHaveLength(1); expect(price(A.data)).toBe(12); expect(serverPrice()).toBe(14);
  });
  it('se a nuvem mudar entre a decisão e o envio, o servidor recusa, nada é sobrescrito e uma nova decisão é pedida', async () => {
    const { A, B } = await scenario();
    A.resolve(pending(A)[0].id, 'keep-local');          // A decide sem ter visto a versão 14
    B.edit(setPrice('farinha', 14)); await B.sync();
    await A.sync();
    expect(serverPrice()).toBe(14); expect(price(A.data)).toBe(12);
    const open = pending(A); expect(open).toHaveLength(1); expect((open[0].server as Ingredient).purchasePrice).toBe(14);
  });
  it('se as duas versões ficarem iguais, o conflito se encerra sem perda', async () => {
    const { A, B } = await scenario();
    B.edit(setPrice('farinha', 12)); await B.sync(); await A.sync();
    expect(pending(A)).toHaveLength(0); expect(A.meta.conflicts[0].resolution?.action).toBe('identical'); expect(price(A.data)).toBe(12);
  });
  it('recuperação: dados já com a escolha mas estado de sincronização antigo (queda no meio) é corrigido sem perda', async () => {
    const { A } = await scenario();
    const crashed = { ...A.data, ingredients: A.data.ingredients.map(i => ({ ...i, purchasePrice: 13 })) }; // dados gravados, meta não
    const healed = healConflicts(crashed, A.meta);
    expect(healed.conflicts.filter(isPendingConflict)).toHaveLength(0); expect(healed.conflicts[0].resolution?.action).toBe('identical');
    expect(buildPushes(crashed, healed)).toEqual([]);
  });
});

describe('Integridade', () => {
  const packaged = () => data({ ingredients: [ing('farinha')], packagings: [{ id: 'paper', name: 'Forminha', purchasePrice: 12, purchaseQuantity: 100, active: true }], recipes: [{ ...rec('brig', 'farinha'), name: 'Brigadeiro Gourmet', packagingItems: [{ packagingId: 'paper', quantityPerUnit: 1 }] }] });
  const setPackagingQuantity = (quantityPerUnit: number) => (d: DataSet): DataSet => ({ ...d, recipes: d.recipes.map(r => ({ ...r, packagingItems: [{ packagingId: 'paper', quantityPerUnit }] })) });
  it('detecta divergência real em embalagens e manter a alteração sincroniza sem recriar o conflito após reload', async () => {
    const { A, B } = await twoDevices(packaged());
    A.offline = true; A.edit(setPackagingQuantity(2)); expect((await A.sync()).status).toBe('offline');
    B.edit(setPackagingQuantity(3)); await B.sync(); A.offline = false; await A.sync();
    const c = pending(A).find(x => x.kind === 'recipes')!;
    expect(c).toBeTruthy();
    const rows = diffRows(c, A.data.packagings);
    expect(rows).toContainEqual({ key: 'packagingItems', label: 'Embalagens da receita', local: 'Forminha · 2 por unidade', server: 'Forminha · 3 por unidade', base: 'Forminha · 1 por unidade' });
    expect(rows.find(r => r.key === 'packagingItems')?.local).not.toContain('[object Object]');
    expect(rows.find(r => r.key === 'packagingItems')?.server).not.toContain('[object Object]');
    A.resolve(c.id, 'keep-local');
    await saveData(A.data); await saveSyncMeta(A.meta); A.data = await loadData(); A.meta = await loadSyncMeta(); // recarga dos dados e metadados antes da sincronização
    expect((await A.sync()).status).toBe('synced');
    expect((await A.sync()).newConflicts).toEqual([]);
    expect(A.data.recipes[0].packagingItems).toEqual([{ packagingId: 'paper', quantityPerUnit: 2 }]);
    await B.sync(); expect(B.data.recipes[0].packagingItems).toEqual([{ packagingId: 'paper', quantityPerUnit: 2 }]);
  });
  it('manter a versão da nuvem preserva embalagem remota após resolução offline e reconexão', async () => {
    const { A, B } = await twoDevices(packaged());
    A.offline = true; A.edit(setPackagingQuantity(2)); await A.sync();
    B.edit(setPackagingQuantity(3)); await B.sync(); A.offline = false; await A.sync();
    const c = pending(A).find(x => x.kind === 'recipes')!;
    A.offline = true; A.resolve(c.id, 'keep-server'); expect((await A.sync()).status).toBe('offline');
    await saveData(A.data); await saveSyncMeta(A.meta); A.data = await loadData(); A.meta = await loadSyncMeta(); A.offline = false;
    expect((await A.sync()).status).toBe('synced');
    expect(A.data.recipes[0].packagingItems).toEqual([{ packagingId: 'paper', quantityPerUnit: 3 }]);
    expect(A.meta.conflicts.find(x => x.id === c.id)?.resolution?.action).toBe('keep-server');
  });
  it('equivalência legado/vazio não cria conflito, mas lista com quantidade diferente continua divergente', async () => {
    const legacy = packaged(); delete (legacy.recipes[0] as Partial<Recipe>).packagingItems;
    const meta = { ...emptyMeta(), revision: 3, baseline: legacy, revs: { ...emptyMeta().revs, recipes: { brig: 2 }, ingredients: { farinha: 1 }, packagings: { paper: 1 } } };
    const local = { ...legacy, recipes: [{ ...legacy.recipes[0], packagingItems: [] }] };
    const pull = { revision: 4, ingredients: [], orders: [], packagings: [], recipes: [{ id: 'brig', rev: 2, deleted: false, data: legacy.recipes[0] }] };
    const noConflict = applyPull(local, meta, pull);
    expect(noConflict.conflicts).toEqual([]);
    const mine = { ...local.recipes[0], packagingItems: [{ packagingId: 'paper', quantityPerUnit: 2 }] };
    const theirs = { ...legacy.recipes[0], packagingItems: [{ packagingId: 'paper', quantityPerUnit: 3 }] };
    expect(applyPull({ ...local, recipes: [mine] }, meta, { ...pull, recipes: [{ ...pull.recipes[0], data: theirs, rev: 4 }] }).conflicts).toHaveLength(1);
  });
  it('alterações em entidades diferentes sincronizam normalmente, sem conflito', async () => {
    const { A, B } = await twoDevices(data({ ingredients: [ing('farinha'), ing('acucar', { purchasePrice: 5 })] }));
    A.edit(setPrice('farinha', 12)); B.edit(setPrice('acucar', 7));
    await A.sync(); await B.sync(); await A.sync();
    expect(price(A.data)).toBe(12); expect(price(B.data, 'acucar')).toBe(7); expect(price(A.data, 'acucar')).toBe(7); expect(price(B.data)).toBe(12);
    expect(A.meta.conflicts).toEqual([]); expect(B.meta.conflicts).toEqual([]);
  });
  it('conflito em uma entidade não impede o envio das outras alterações', async () => {
    const { A, B } = await twoDevices(data({ ingredients: [ing('farinha'), ing('acucar', { purchasePrice: 5 })] }));
    A.edit(d => setPrice('acucar', 8)(setPrice('farinha', 12)(d))); B.edit(setPrice('farinha', 13)); await B.sync();
    await A.sync();
    expect(srv.table('ingredients').find(r => r.id === 'acucar')?.purchase_price).toBe(8); // o que não conflita foi enviado
    expect(serverPrice()).toBe(13); expect(pending(A)).toHaveLength(1);
  });
  it('conflitos simultâneos ficam todos preservados e são resolvidos de forma independente', async () => {
    const { A, B } = await twoDevices(data({ ingredients: [ing('farinha'), ing('acucar', { purchasePrice: 5 })] }));
    A.edit(d => setPrice('acucar', 8)(setPrice('farinha', 12)(d))); B.edit(d => setPrice('acucar', 9)(setPrice('farinha', 13)(d))); await B.sync();
    await A.sync();
    expect(pending(A)).toHaveLength(2);
    const [f, a] = ['farinha', 'acucar'].map(id => pending(A).find(c => c.entityId === id)!);
    A.resolve(f.id, 'keep-local'); expect(pending(A)).toHaveLength(1);
    A.resolve(a.id, 'keep-server'); expect(pending(A)).toHaveLength(0);
    await A.sync(); expect(serverPrice()).toBe(12); expect(srv.table('ingredients').find(r => r.id === 'acucar')?.purchase_price).toBe(9);
  });
  it('rede cai depois de o servidor gravar a versão escolhida: repetir não duplica nem cria conflito consigo mesmo', async () => {
    const { A } = await scenario();
    A.resolve(pending(A)[0].id, 'keep-local');
    A.dropNextPushResponse = true; expect((await A.sync()).status).toBe('offline');
    const again = await A.sync();
    expect(again.status).toBe('synced'); expect(again.newConflicts).toEqual([]); expect(pending(A)).toHaveLength(0);
    expect(serverPrice()).toBe(12); expect(srv.table('ingredients')).toHaveLength(1);
  });
  it('excluído em outro dispositivo e editado aqui: conflito pendente; manter a minha recria o registro', async () => {
    const { A, B } = await twoDevices();
    A.edit(setPrice('farinha', 12)); B.edit(d => ({ ...d, ingredients: [] })); await B.sync();
    await A.sync();
    expect(price(A.data)).toBe(12); const [c] = pending(A); expect(c).toMatchObject({ reason: 'deleted-elsewhere', server: null });
    expect(diffRows(c)[0]).toMatchObject({ local: 'Mantido', server: 'Excluído' });
    A.resolve(c.id, 'keep-local'); expect((await A.sync()).status).toBe('synced');
    expect(serverPrice()).toBe(12); expect(srv.table('ingredients').find(r => r.id === 'farinha')?.deleted_at ?? null).toBeNull();
  });
  it('excluído lá e editado aqui: aceitar a exclusão é recusado enquanto algo novo daqui depende do item, e esse algo novo não é enviado', async () => {
    const { A, B } = await twoDevices();
    A.edit(d => ({ ...setPrice('farinha', 12)(d), recipes: [rec('r2', 'farinha')] })); // receita nova que usa a farinha
    B.edit(d => ({ ...d, ingredients: [] })); await B.sync();
    await A.sync();
    const c = pending(A).find(x => x.kind === 'ingredients')!;
    expect(c).toMatchObject({ reason: 'deleted-elsewhere', server: null });
    expect(srv.table('recipes')).toHaveLength(0); // a receita nova espera a decisão (enviá-la apontaria para um ingrediente excluído)
    expect(() => A.resolve(c.id, 'keep-server')).toThrow(/Não é possível aplicar/);
    expect(price(A.data)).toBe(12);
    A.resolve(c.id, 'keep-local'); expect((await A.sync()).status).toBe('synced'); expect(srv.table('recipes')).toHaveLength(1);
  });
  it('isolamento entre contas: o conflito de uma conta não aparece para outra', async () => {
    await srv.issueFor('carla@exemplo.com');
    const { A } = await scenario();
    const C = await device('Notebook da Carla', 'carla@exemplo.com');
    await C.sync();
    expect(C.meta.conflicts).toEqual([]); expect(C.data.ingredients).toEqual([]);
    expect(pending(A)).toHaveLength(1); // e o da Bia continua só dela
  });
});

describe('Dados financeiros', () => {
  const base = () => data({ ingredients: [ing('farinha')], recipes: [rec('r', 'farinha')], orders: [ord('o1')] });
  const paymentsOf = () => JSON.stringify(srv.table('order_payments').map(p => [p.id, p.amount]).sort());
  it('pagamentos lançados nos dois lados: reconciliação explícita; nada é descartado nem duplicado', async () => {
    const { A, B } = await twoDevices(base());
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, payments: [{ id: 'pa', amount: 50, receivedAt: '2026-11-12' }] })) }));
    B.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, payments: [{ id: 'pb', amount: 30, receivedAt: '2026-11-12' }] })) })); await B.sync();
    await A.sync();
    const open = A.meta.conflicts.filter(c => c.financial && !c.resolution);
    expect(open).toHaveLength(1); expect(open[0].financial?.addedPayments.map(p => p.id)).toEqual(['pa']); // o recebimento local está guardado
    await A.sync(); await A.sync();
    expect(A.meta.conflicts.filter(c => c.financial && !c.resolution)).toHaveLength(1); // retries não duplicam nem eliminam
    expect(srv.table('order_payments').map(p => p.id)).not.toContain('pa');
  });
  it('conflito em campo não financeiro da encomenda: manter a minha versão NUNCA apaga recebimentos da nuvem', async () => {
    const { A, B } = await twoDevices(base());
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Ana Paula' })) }));
    B.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Ana P.', payments: [{ id: 'pb', amount: 30, receivedAt: '2026-11-12' }] })) })); await B.sync();
    await A.sync();
    const c = pending(A)[0]; expect(c).toMatchObject({ kind: 'orders', pending: true });
    A.resolve(c.id, 'keep-local'); await A.sync();
    expect(srv.table('orders')[0].customer).toBe('Ana Paula');
    expect(srv.table('order_payments').map(p => p.id)).toEqual(['pb']); // o recebimento feito no outro dispositivo foi preservado
    expect(A.data.orders[0].payments?.map(p => p.id)).toEqual(['pb']);
    expect(paymentsOf()).toContain('30');
  });
  it('manter a minha versão que faria os recebimentos passarem do total é recusado', async () => {
    const { A, B } = await twoDevices(base()); // total = 2 × 100 = 200
    A.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, customer: 'Ana P.', deposit: 190 })) }));
    B.edit(d => ({ ...d, orders: d.orders.map(o => ({ ...o, payments: [{ id: 'pb', amount: 30, receivedAt: '2026-11-12' }] })) })); await B.sync();
    await A.sync();
    const c = pending(A).find(x => x.kind === 'orders');
    if (c) expect(() => A.resolve(c.id, 'keep-local')).toThrow(/passarem do total/);
    else expect(A.meta.conflicts.some(x => x.financial && !x.resolution)).toBe(true); // ou caiu na reconciliação financeira explícita
  });
});

describe('Estado persistido', () => {
  it('conflitos sobrevivem ao IndexedDB com todas as versões (local, nuvem e base)', async () => {
    const { A } = await scenario();
    await saveSyncMeta(A.meta);
    const back = await loadSyncMeta();
    const c = back.conflicts.find(isPendingConflict) as ConflictRecord;
    expect(c).toMatchObject({ pending: true, serverRev: expect.any(Number) });
    expect([c.base, c.local, c.server].map(v => (v as Ingredient).purchasePrice)).toEqual([11, 12, 13]);
  });
});
