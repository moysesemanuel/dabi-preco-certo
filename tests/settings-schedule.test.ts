import { beforeEach, describe, expect, it } from 'vitest';
import { parseSettings, validateDataSet } from '../shared/dataset';
import { emptyPush } from '../shared/sync';
import type { Recipe, Settings } from '../src/domain/types';
import { Device } from './helpers/device';
import { makeServer, type Server } from './helpers/server';

describe('Configurações do negócio e da capacidade', () => {
  it('aceita configurações completas e normaliza (nome aparado, dias ordenados)', () => {
    expect(parseSettings({ cupSizeMl: 240, businessName: '  Doces da Bia ', businessPhone: '5541999990000', dailyCapacityMinutes: 240, workWeekdays: [6, 1, 3] }))
      .toEqual({ cupSizeMl: 240, businessName: 'Doces da Bia', businessPhone: '5541999990000', dailyCapacityMinutes: 240, workWeekdays: [1, 3, 6] });
    expect(parseSettings({ cupSizeMl: 250 })).toEqual({ cupSizeMl: 250 });
    expect(parseSettings({ cupSizeMl: 240, businessName: '  ', businessPhone: '' })).toEqual({ cupSizeMl: 240 }); // vazio = não informado
  });
  it('rejeita valores inválidos', () => {
    const bad = (o: Record<string, unknown>) => expect(() => parseSettings({ cupSizeMl: 240, ...o }), JSON.stringify(o)).toThrow();
    bad({ businessName: 'x'.repeat(81) }); bad({ businessName: 5 });
    bad({ businessPhone: '123' }); bad({ businessPhone: '(41) 99999-0000' }); bad({ businessPhone: '1'.repeat(16) }); bad({ businessPhone: 5541999990000 });
    bad({ dailyCapacityMinutes: -1 }); bad({ dailyCapacityMinutes: 1441 }); bad({ dailyCapacityMinutes: 1.5 }); bad({ dailyCapacityMinutes: '240' }); bad({ dailyCapacityMinutes: NaN });
    bad({ workWeekdays: [] }); bad({ workWeekdays: [7] }); bad({ workWeekdays: [1, 1] }); bad({ workWeekdays: [-1] }); bad({ workWeekdays: 'seg' }); bad({ workWeekdays: [0, 1, 2, 3, 4, 5, 6, 0] });
    for (const raw of [null, 'x', {}, { cupSizeMl: 0 }, { cupSizeMl: 5000 }]) expect(() => parseSettings(raw)).toThrow();
  });
  it('o backup valida as configurações novas', () => {
    const ok = { schemaVersion: 3, ingredients: [], recipes: [], orders: [], settings: { cupSizeMl: 240, businessName: 'Bia', dailyCapacityMinutes: 120 } };
    expect(validateDataSet(ok).settings).toEqual({ cupSizeMl: 240, businessName: 'Bia', dailyCapacityMinutes: 120 });
    expect(() => validateDataSet({ ...ok, settings: { cupSizeMl: 240, dailyCapacityMinutes: -5 } })).toThrow('Configurações');
  });
  it('tempo de produção da receita é validado no backup', () => {
    const recipe = (prepMinutes: unknown) => ({ schemaVersion: 3, ingredients: [{ id: 'f', name: 'F', unit: 'g', purchaseQuantity: 1, purchasePrice: 1 }], orders: [], recipes: [{ id: 'r', name: 'B', yield: 1, items: [{ ingredientId: 'f', quantity: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 10, prepMinutes }] });
    expect(validateDataSet(recipe(90)).recipes[0].prepMinutes).toBe(90);
    expect('prepMinutes' in validateDataSet(recipe(undefined)).recipes[0]).toBe(false);
    for (const bad of [0, -1, NaN, '60', 10_081, Infinity]) expect(() => validateDataSet(recipe(bad)), String(bad)).toThrow(/tempo de produção/);
  });
});

describe('Sincronização do tempo de produção e das configurações', () => {
  let s: Server;
  beforeEach(async () => { s = makeServer(); await s.issueFor('bia@exemplo.com'); });
  const recipe = (over: Partial<Recipe> = {}): Recipe => ({ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 20, ...over });
  const settings: Settings = { cupSizeMl: 250, businessName: 'Doces da Bia', businessPhone: '5541999990000', dailyCapacityMinutes: 300, workWeekdays: [1, 2, 3, 4, 5] };

  it('viajam para o servidor e para o outro dispositivo', async () => {
    const A = new Device(s, await s.login('bia@exemplo.com', 'Celular')), B = new Device(s, await s.login('bia@exemplo.com', 'Notebook'));
    A.edit(d => ({ ...d, ingredients: [{ id: 'f', name: 'Farinha', unit: 'g', purchaseQuantity: 1000, purchasePrice: 6 }], recipes: [recipe({ prepMinutes: 90 })], settings }));
    expect((await A.sync()).status).toBe('synced');
    expect(s.table('recipes')[0].prep_minutes).toBe(90);
    await B.sync();
    expect(B.data.recipes[0].prepMinutes).toBe(90); expect(B.data.settings).toEqual(settings);
    A.edit(d => ({ ...d, recipes: [recipe()] })); // remove o tempo
    await A.sync(); await B.sync();
    expect('prepMinutes' in B.data.recipes[0]).toBe(false); expect(s.table('recipes')[0].prep_minutes).toBeNull();
  });
  it('o servidor recusa configurações e tempos inválidos', async () => {
    const bia = await s.login('bia@exemplo.com');
    const send = (build: (p: ReturnType<typeof emptyPush>) => void) => { const p = emptyPush(0); build(p); return s.request('POST', '/api/sync/v2/push', { session: bia, body: p }); };
    expect((await send(p => { p.upserts.settings = { cupSizeMl: 240, businessPhone: '123' }; })).status).toBe(400);
    expect((await send(p => { p.upserts.settings = { cupSizeMl: 240, workWeekdays: [9] }; })).status).toBe(400);
    expect((await send(p => { p.upserts.ingredients = [{ id: 'f', name: 'F', unit: 'g', purchaseQuantity: 1, purchasePrice: 1 }]; p.upserts.recipes = [recipe({ prepMinutes: -3 })]; })).status).toBe(400);
    expect(s.table('recipes')).toHaveLength(0);
  });
});
