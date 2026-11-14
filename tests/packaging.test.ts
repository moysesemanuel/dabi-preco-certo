import { asOrder } from './helpers/orders';
import { describe, expect, it } from 'vitest';
import { packagingUnitCost, suggestPackagingQuantity } from '../src/domain/packaging';
import { recipeCost } from '../src/domain/pricing';
import { round2 } from '../src/domain/pricing';
import { toCents2 } from '../src/domain/money';
import { captureCostSnapshot, orderTotalCost } from '../src/domain/orderCost';
import { validateDataSet } from '../shared/dataset';
import type { DataSet } from '../src/domain/types';
import { createTestD1 } from './helpers/d1';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('embalagens', () => {
  it('preserva custo subcentavo até o lote', () => {
    expect(packagingUnitCost(0.01, 200)).toBe(0.00005);
    expect(packagingUnitCost(12, 100)).toBe(0.12);
    expect(round2(8.005)).toBe(8.01);
    expect(toCents2(8.005)).toBe(8.01);
  });
  it('valida compra e sugere caixas por quantidade/capacidade', () => {
    expect(() => packagingUnitCost(-1, 10)).toThrow();
    expect(() => packagingUnitCost(4, 0)).toThrow();
    expect(suggestPackagingQuantity(100, 25)).toBe(4);
    expect(suggestPackagingQuantity(101, 25)).toBe(5);
  });
  it('soma embalagens unitárias no custo da receita e mantém precisão ao agregar lote', () => {
    const packaging = [{ id: 'tiny', name: 'Lacre', purchasePrice: 0.01, purchaseQuantity: 200, active: true }, { id: 'bag', name: 'Saco', purchasePrice: 8, purchaseQuantity: 100, active: true }];
    const recipe = { id: 'r', name: 'Doce', yield: 100, items: [], packagingPerUnit: 0, packagingItems: [{ packagingId: 'tiny', quantityPerUnit: 1 }, { packagingId: 'bag', quantityPerUnit: 1 }], laborTotal: 0, extraTotal: 0, desiredMargin: 25 };
    const cost = recipeCost(recipe, [], undefined, packaging);
    expect(cost.costPerUnitExact).toBeCloseTo(0.08005, 10);
    expect(cost.packaging).toBe(8.01);
    expect(cost.costPerUnit).toBe(0.08);
  });
  it('congela embalagens associadas na encomenda e não muda com o catálogo', () => {
    const d: DataSet = { schemaVersion: 4, ingredients: [], packagings: [{ id: 'p', name: 'Caixa', purchasePrice: 4.5, purchaseQuantity: 1, capacity: 25, active: true }], recipes: [{ id: 'r', name: 'Doces', yield: 1, items: [], packagingPerUnit: 0, packagingItems: [{ packagingId: 'p', quantityPerUnit: 1 }], laborTotal: 0, extraTotal: 0, desiredMargin: 20 }], orders: [] };
    const snap = captureCostSnapshot(d.recipes[0], d, new Date('2026-11-13T10:00:00Z'))!;
    expect(snap.costPerUnit).toBe(4.5);
    expect(snap.packagingItems).toEqual([{ packagingId: 'p', name: 'Caixa', quantityPerUnit: 1, unitCost: 4.5 }]);
    const order = asOrder({ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 100, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado' as const, createdAt: '2026-11-13T10:00:00.000Z', costSnapshot: snap, packagingItems: [{ packagingId: 'p', name: 'Caixa especial', quantity: 4, unitCost: 4.5 }] });
    expect(orderTotalCost(order, { ...d, packagings: [{ ...d.packagings[0], purchasePrice: 9 }] })).toBe(468);
    expect(order.items[0].quantity).toBe(100);
  });
  it('migração local preserva pedidos e pagamentos existentes e cria as tabelas aditivas', () => {
    const db = createTestD1({ upTo: '0009_admin.sql' });
    db.raw.exec("INSERT INTO users(id,email,created_at) VALUES('u','u@example.com','2026-11-13T10:00:00.000Z')");
    db.raw.exec("INSERT INTO sync_state(user_id,revision,updated_at) VALUES('u',1,'2026-11-13T10:00:00.000Z')");
    db.raw.exec("INSERT INTO recipes(user_id,id,name,yield,packaging_per_unit,labor_total,extra_total,desired_margin,rev) VALUES('u','r','Doce',10,1,2,3,20,1)");
    db.raw.exec("INSERT INTO orders(user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,quote_code,rev) VALUES('u','o','Ana','r',2,5,1,'2026-12-01','Confirmado','2026-11-13T10:00:00.000Z',4,'2026-11-13T10:00:00.000Z','ORC-ABCDEF',1)");
    db.raw.exec("INSERT INTO order_payments(user_id,order_id,position,id,amount,received_at) VALUES('u','o',0,'p',1,'2026-11-13')");
    const before = JSON.stringify(db.raw.prepare('SELECT user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,quote_code,rev,deleted_at FROM orders').all()); const payments = JSON.stringify(db.raw.prepare('SELECT * FROM order_payments').all());
    db.raw.exec(readFileSync(resolve(process.cwd(), 'worker/migrations/0010_packagings.sql'), 'utf8'));
    expect(JSON.stringify(db.raw.prepare('SELECT user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,quote_code,rev,deleted_at FROM orders').all())).toBe(before);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM order_payments').all())).toBe(payments);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='packagings'").get()).toBeTruthy();
  });
  it('aceita backup antigo sem catálogo e retorna coleção vazia', () => {
    const legacy = { schemaVersion: 3, ingredients: [], recipes: [], orders: [] };
    expect(validateDataSet(legacy).packagings).toEqual([]);
  });
  it('backup valida coleção e preserva associações e snapshots congelados', () => {
    const source = { schemaVersion: 4, ingredients: [], packagings: [{ id: 'p', name: 'Caixa', purchasePrice: 4.5, purchaseQuantity: 1, capacity: 25, active: false }], recipes: [{ id: 'r', name: 'Doce', yield: 10, items: [], packagingItems: [{ packagingId: 'p', quantityPerUnit: 1 }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 20 }], orders: [{ id: 'o', customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-13T10:00:00.000Z', costSnapshot: { costPerUnit: 4.5, capturedAt: '2026-11-13T10:00:00.000Z', packagingItems: [{ packagingId: 'p', name: 'Caixa histórica', quantityPerUnit: 1, unitCost: 4.5 }] }, packagingItems: [{ packagingId: 'p', name: 'Sacola especial', quantity: 1, unitCost: 2 }] }] };
    expect(validateDataSet(source)).toMatchObject({ packagings: [{ active: false }], recipes: [{ packagingItems: [{ packagingId: 'p' }] }], orders: [{ packagingItems: [{ name: 'Sacola especial' }], items: [{ costSnapshot: { packagingItems: [{ name: 'Caixa histórica' }] } }] }] });
    expect(() => validateDataSet({ ...source, packagings: [] })).toThrow(/inexistente/);
  });
});
