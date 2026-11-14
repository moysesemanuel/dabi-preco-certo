import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyQuoteCode, isQuoteCode, withQuoteCodes } from '../../shared/quoteCode';
import { Device } from '../helpers/device';
import { createTestD1 } from '../helpers/d1';
import { makeServer } from '../helpers/server';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATIONS = new URL('../../worker/migrations/', import.meta.url);
const sql = (file: string) => readFileSync(new URL(file, MIGRATIONS), 'utf8');
const legacy = () => createTestD1({ upTo: '0006_prep_minutes.sql' });

type Raw = InstanceType<typeof DatabaseSync>;
const tablesOf = (raw: Raw) => (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name").all() as { name: string }[]).map(t => t.name);
const columnsOf = (raw: Raw, table: string) => (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
const countOf = (raw: Raw, table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Impressão digital de UM conjunto EXPLÍCITO de colunas (as mesmas antes e depois: nunca "ignora" coluna para fazer a comparação passar). */
const fingerprint = (raw: Raw, table: string, cols: string[]) => {
  if (!cols.length) return '';
  const rows = raw.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${cols.map((_, i) => i + 1).join(', ')}`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};

const ALL_FILES = () => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
/** Migrações realmente aplicadas, lidas da tabela `d1_migrations` (como o Wrangler registra). Recusa estados que não sejam um prefixo contínuo 0001…000N. */
export function appliedMigrations(raw: Raw): string[] {
  if (!tablesOfAll(raw).includes('d1_migrations')) throw new Error('sem a tabela d1_migrations: não parece um banco/backup do D1.');
  const applied = (raw.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]).map(r => r.name);
  const files = ALL_FILES();
  if (applied.some((n, i) => n !== files[i])) throw new Error(`migrações aplicadas fora de ordem ou desconhecidas: ${applied.join(', ')}`);
  return applied;
}
const tablesOfAll = (raw: Raw) => (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);

export type Report = { applied: string[]; pending: string[]; tables: { name: string; rows: number; columns: number }[]; codesAssigned: number; financial: { orders: number; payments: number } };

/**
 * Ensaio genérico para QUALQUER estágio de migração (0001–0006, 0001–0007 ou 0001–0008):
 *  1. detecta as aplicadas pelo `d1_migrations` e simula SÓ as pendentes;
 *  2. compara, tabela a tabela, contagens e impressão digital das MESMAS colunas de antes (incluindo `catalog_ref`/`quote_code` quando já existiam);
 *  3. confere o esquema final (colunas e índice único) e a integridade financeira;
 *  4. simula a atribuição de códigos aos pedidos sem código (derivados, únicos por conta), sem alterar códigos já existentes nem nenhuma outra coluna.
 * `afterMigrations` existe para provar que divergências REAIS são detectadas (teste negativo).
 */
export function rehearseMigrations(raw: Raw, hooks: { afterMigrations?: (raw: Raw) => void } = {}): Report {
  const applied = appliedMigrations(raw);
  const pending = ALL_FILES().filter(f => !applied.includes(f));
  const noCode = (name: string, cols: string[]) => cols.filter(c => !(name === 'orders' && c === 'quote_code')); // a atribuição de códigos só pode mexer nesta coluna
  const before = tablesOf(raw).map(name => { const cols = columnsOf(raw, name); return { name, cols, rows: countOf(raw, name), fp: fingerprint(raw, name, cols), fpNoCode: fingerprint(raw, name, noCode(name, cols)) }; });
  const financialBefore = fingerprint(raw, 'orders', ['user_id', 'id', 'quantity', 'unit_price', 'deposit', 'status', 'created_at', 'delivery_date', 'cost_per_unit', 'cost_captured_at', 'deleted_at']) + fingerprint(raw, 'order_payments', columnsOf(raw, 'order_payments'));
  const hadCodes = columnsOf(raw, 'orders').includes('quote_code');
  const codesBefore = hadCodes ? (raw.prepare('SELECT user_id, id, quote_code FROM orders WHERE quote_code IS NOT NULL ORDER BY user_id, id').all() as { user_id: string; id: string; quote_code: string }[]) : [];

  for (const f of pending) { raw.exec(sql(f)); raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f); }
  hooks.afterMigrations?.(raw);

  for (const t of before) {
    expect(countOf(raw, t.name), `${t.name}: linhas`).toBe(t.rows);
    expect(fingerprint(raw, t.name, t.cols), `${t.name}: valores das colunas preexistentes (${t.cols.join(', ')})`).toBe(t.fp);
  }
  expect(appliedMigrations(raw)).toEqual(ALL_FILES());
  expect(columnsOf(raw, 'ingredients')).toContain('catalog_ref'); expect(columnsOf(raw, 'orders')).toContain('quote_code');
  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_orders_quote_code'").get() as { sql: string } | undefined;
  expect(idx?.sql).toMatch(/UNIQUE[\s\S]*\(user_id, quote_code\)[\s\S]*WHERE quote_code IS NOT NULL/i);

  // Atribuição de códigos pelo app (derivados e únicos por conta), respeitando os que já existem.
  const orders = raw.prepare('SELECT user_id, id, quote_code FROM orders ORDER BY created_at, id').all() as { user_id: string; id: string; quote_code: string | null }[];
  const used = new Set(orders.filter(o => o.quote_code).map(o => `${o.user_id}:${o.quote_code}`));
  let assigned = 0;
  for (const o of orders.filter(x => !x.quote_code)) {
    let salt = 0, c = legacyQuoteCode(o.id, salt); while (used.has(`${o.user_id}:${c}`)) c = legacyQuoteCode(o.id, ++salt);
    used.add(`${o.user_id}:${c}`); raw.prepare('UPDATE orders SET quote_code = ? WHERE user_id = ? AND id = ?').run(c, o.user_id, o.id); assigned++; // o índice único recusaria qualquer repetição
  }
  for (const c of codesBefore) expect(raw.prepare('SELECT quote_code FROM orders WHERE user_id = ? AND id = ?').get(c.user_id, c.id), `código existente de ${c.id}`).toEqual({ quote_code: c.quote_code });
  expect(raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NULL').get()).toEqual({ n: 0 });
  for (const t of before) expect(fingerprint(raw, t.name, noCode(t.name, t.cols)), `${t.name}: nada além do código mudou`).toBe(t.fpNoCode);
  const financialAfter = fingerprint(raw, 'orders', ['user_id', 'id', 'quantity', 'unit_price', 'deposit', 'status', 'created_at', 'delivery_date', 'cost_per_unit', 'cost_captured_at', 'deleted_at']) + fingerprint(raw, 'order_payments', columnsOf(raw, 'order_payments'));
  expect(financialAfter, 'dados financeiros dos pedidos e recebimentos').toBe(financialBefore);
  return { applied, pending, tables: before.map(t => ({ name: t.name, rows: t.rows, columns: t.cols.length })), codesAssigned: assigned, financial: { orders: countOf(raw, 'orders'), payments: countOf(raw, 'order_payments') } };
}

/** Cria o controle de migrações como o Wrangler (`d1_migrations`) num banco de teste já migrado até `upTo`. */
function recordMigrations(raw: Raw, upTo: string) {
  raw.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const f of ALL_FILES()) { if (f > upTo) break; raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f); }
}

/** Dados antigos sintéticos e representativos: várias contas, pedidos com recebimentos e custo registrado, itens excluídos, links publicados. */
function seedLegacy(raw: InstanceType<typeof DatabaseSync>) {
  const run = (q: string, ...p: (string | number | null)[]) => raw.prepare(q).run(...p);
  const now = '2026-11-01T10:00:00.000Z';
  for (const [u, email] of [['usr_a', 'bia@exemplo.com'], ['usr_b', 'carla@exemplo.com']]) {
    run('INSERT INTO users (id, email, email_verified_at, created_at) VALUES (?,?,?,?)', u, email, now, now);
    run('INSERT INTO sync_state (user_id, revision, updated_at, settings_json, settings_rev) VALUES (?,?,?,?,?)', u, 40, now, '{"cupSizeMl":240}', 3);
    for (let i = 0; i < 6; i++) run('INSERT INTO ingredients (user_id,id,name,unit,purchase_quantity,purchase_price,density_g_per_ml,grams_per_unit,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)', u, `i${i}`, `Ingrediente ${i}`, 'g', 1000, 5 + i, i % 2 ? 0.5 : null, null, 1 + i, i === 5 ? now : null);
    for (let r = 0; r < 3; r++) { run('INSERT INTO recipes (user_id,id,name,yield,packaging_per_unit,labor_total,extra_total,desired_margin,prep_minutes,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', u, `r${r}`, `Receita ${r}`, 10, 1, 10, 2, 30, r ? 60 : null, 10 + r, null); run('INSERT INTO recipe_items (user_id,recipe_id,position,ingredient_id,quantity,unit) VALUES (?,?,?,?,?,?)', u, `r${r}`, 0, `i${r}`, 100, 'g'); }
    for (let o = 0; o < 8; o++) {
      run('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', u, `o${o}`, `Cliente ${o}`, `r${o % 3}`, 2, 40, 10, '2026-12-01', 'Confirmado', `2026-11-0${1 + (o % 5)}T10:00:00.000Z`, o % 2 ? 3.5 : null, o % 2 ? now : null, 20 + o, o === 7 ? now : null);
      if (o % 3 === 0) run('INSERT INTO order_payments (user_id,order_id,position,id,amount,received_at,method,note) VALUES (?,?,?,?,?,?,?,?)', u, `o${o}`, 0, `p${o}`, 20, '2026-11-12', 'Pix', null);
    }
    run('INSERT INTO licenses (id,key_hash,label,status,quota_active,quota_daily,created_at,email,user_id) VALUES (?,?,?,?,?,?,?,?,?)', `lic_${u}`, `h_${u}`, 'x', 'active', 100, 30, now, email, u);
    run('INSERT INTO quotes (id,payload,created_at,updated_at,owner_id) VALUES (?,?,?,?,?)', `q${u}`.padEnd(22, 'x'), '{"version":1}', now, now, `lic_${u}`);
    run('INSERT INTO rate_limits (license_id,scope,window_start,count) VALUES (?,?,?,?)', `lic_${u}`, 'sync', 1000, 3);
  }
}

describe('Migrações 0007 e 0008 sobre dados antigos (banco descartável, dados sintéticos)', () => {
  it.each([
    ['0001–0006', '0006_prep_minutes.sql', ['0007_catalog_ref.sql', '0008_quote_code.sql', '0009_admin.sql', '0010_packagings.sql', '0011_order_packaging_charge.sql']],
    ['0001–0007', '0007_catalog_ref.sql', ['0008_quote_code.sql', '0009_admin.sql', '0010_packagings.sql', '0011_order_packaging_charge.sql']],
    ['0001–0008', '0008_quote_code.sql', ['0009_admin.sql', '0010_packagings.sql', '0011_order_packaging_charge.sql']],
  ])('estágio %s: detecta as aplicadas, simula só as pendentes e nada preexistente muda (mesmas colunas antes e depois)', (_n, upTo, expectedPending) => {
    const db = createTestD1({ upTo }); seedLegacy(db.raw); recordMigrations(db.raw, upTo);
    // Estágios mais novos já têm valores nas colunas que existem: eles precisam sobreviver intactos.
    if (upTo >= '0007') db.raw.prepare("UPDATE ingredients SET catalog_ref = '{\"id\":\"farinha-de-trigo\",\"variant\":\"padrao\",\"version\":\"2026.11.1\",\"densityGPerMl\":0.5283}' WHERE id IN ('i0','i2')").run();
    if (upTo >= '0008') { db.raw.prepare("UPDATE orders SET quote_code = 'ORC-K7M42P' WHERE user_id = 'usr_a' AND id = 'o0'").run(); db.raw.prepare("UPDATE orders SET quote_code = 'ORC-K7M42P' WHERE user_id = 'usr_b' AND id = 'o0'").run(); db.raw.prepare("UPDATE orders SET quote_code = 'ORC-ABCDEF' WHERE user_id = 'usr_a' AND id = 'o3'").run(); }
    const r = rehearseMigrations(db.raw);
    expect(r.pending).toEqual(expectedPending); expect(r.applied.length + r.pending.length).toBe(ALL_FILES().length);
    expect(r.tables.length).toBe(12); expect(r.financial.orders).toBe(16); expect(r.financial.payments).toBe(6);
    expect(tablesOf(db.raw)).toContain('packagings'); expect(tablesOf(db.raw)).toContain('recipe_packaging_items');
    expect(r.codesAssigned).toBe(upTo >= '0008' ? 13 : 16); // pedidos que ainda não tinham código (os que já tinham, nunca mudam)
    if (upTo >= '0007') expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ingredients WHERE catalog_ref IS NOT NULL").get()).toEqual({ n: 4 }); // i0 e i2 das duas contas
    if (upTo >= '0008') expect(db.raw.prepare("SELECT quote_code FROM orders WHERE user_id = 'usr_a' AND id = 'o3'").get()).toEqual({ quote_code: 'ORC-ABCDEF' });
  });

  it('no estágio 0001–0006 as colunas novas nascem vazias (NULL) em todas as linhas', () => {
    const db = legacy(); seedLegacy(db.raw); recordMigrations(db.raw, '0006_prep_minutes.sql');
    const original = { ingredients: countOf(db.raw, 'ingredients'), orders: countOf(db.raw, 'orders') };
    for (const f of ['0007_catalog_ref.sql', '0008_quote_code.sql']) db.raw.exec(sql(f));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM ingredients WHERE catalog_ref IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NOT NULL').get()).toEqual({ n: 0 });
    expect([countOf(db.raw, 'ingredients'), countOf(db.raw, 'orders')]).toEqual([original.ingredients, original.orders]);
  });

  it('NÃO esconde divergências reais: uma migração que altere um valor existente, apague uma linha ou mexa em dinheiro faz o ensaio falhar', () => {
    const run = (evil: string) => { const db = legacy(); seedLegacy(db.raw); recordMigrations(db.raw, '0006_prep_minutes.sql'); return () => rehearseMigrations(db.raw, { afterMigrations: raw => raw.exec(evil) }); };
    expect(run("UPDATE ingredients SET purchase_price = purchase_price + 1 WHERE id = 'i0'")).toThrow(/ingredients/);
    expect(run("DELETE FROM orders WHERE id = 'o1'")).toThrow(/orders/);
    expect(run("UPDATE order_payments SET amount = amount + 1")).toThrow();
    expect(run("UPDATE orders SET deposit = deposit + 1 WHERE id = 'o2'")).toThrow();
    expect(run("UPDATE quotes SET payload = '{}'")).toThrow(); // até tabelas sem relação com a mudança
  });

  it('recusa estados que não são um banco do D1 ou cujas migrações aplicadas estão fora de ordem', () => {
    const noTable = legacy(); expect(() => appliedMigrations(noTable.raw)).toThrow(/d1_migrations/);
    const skewed = legacy(); skewed.raw.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
    skewed.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0001_quotes.sql'); skewed.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0003_accounts.sql');
    expect(() => appliedMigrations(skewed.raw)).toThrow(/fora de ordem/);
  });

  it('o índice único é parcial: aceita muitos pedidos antigos sem código, recusa repetição na mesma conta e aceita em contas diferentes', () => {
    const db = legacy(); seedLegacy(db.raw); db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql'));
    const idx = db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_orders_quote_code'").get() as { sql: string };
    expect(idx.sql).toMatch(/UNIQUE/i); expect(idx.sql).toMatch(/\(user_id, quote_code\)/); expect(idx.sql).toMatch(/WHERE quote_code IS NOT NULL/i);
    const set = (u: string, o: string, c: string | null) => db.raw.prepare('UPDATE orders SET quote_code = ? WHERE user_id = ? AND id = ?').run(c, u, o);
    expect(() => { for (let o = 0; o < 8; o++) set('usr_a', `o${o}`, null); }).not.toThrow(); // muitos NULL: ok (dados legados sem código)
    set('usr_a', 'o0', 'ORC-K7M42P'); set('usr_b', 'o0', 'ORC-K7M42P'); // contas diferentes: ok
    expect(() => set('usr_a', 'o1', 'ORC-K7M42P')).toThrow(/UNIQUE/);
    expect(() => set('usr_a', 'o7', 'ORC-K7M42P')).toThrow(/UNIQUE/); // o7 está excluído (logicamente), mas o código dele continua reservado
  });

  it('não são reaplicáveis (ALTER TABLE): dependem do controle de migrações do Wrangler, que não repete as já aplicadas', () => {
    const db = legacy(); db.raw.exec(sql('0007_catalog_ref.sql'));
    expect(() => db.raw.exec(sql('0007_catalog_ref.sql'))).toThrow(/duplicate column/i);
  });

  it('0007 e 0008 são independentes entre si (colunas em tabelas diferentes): qualquer ordem funciona; só devem ser aplicadas nesta ordem por convenção', () => {
    const a = legacy(); a.raw.exec(sql('0008_quote_code.sql')); a.raw.exec(sql('0007_catalog_ref.sql'));
    const b = legacy(); b.raw.exec(sql('0007_catalog_ref.sql')); b.raw.exec(sql('0008_quote_code.sql'));
    const shape = (d: ReturnType<typeof legacy>) => ['ingredients', 'orders'].map(t => (d.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name).sort());
    expect(shape(a)).toEqual(shape(b));
  });

  it('as migrações do repositório são exatamente as esperadas (nenhuma extra, nenhuma faltando)', () => {
    expect(readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()).toEqual(['0001_quotes.sql', '0002_licenses.sql', '0003_accounts.sql', '0004_data.sql', '0005_payments.sql', '0006_prep_minutes.sql', '0007_catalog_ref.sql', '0008_quote_code.sql', '0009_admin.sql', '0010_packagings.sql', '0011_order_packaging_charge.sql']);
    for (const f of ['0007_catalog_ref.sql', '0008_quote_code.sql', '0009_admin.sql', '0010_packagings.sql', '0011_order_packaging_charge.sql']) expect(sql(f), f).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b|UPDATE\s+\w+\s+SET/i);
  });
});

describe('Atualização completa em ensaio: banco antigo → migração → Worker novo → app novo', () => {
  async function legacyServer() {
    const db = legacy(); const s = makeServer(undefined, { db });
    await s.issueFor('bia@exemplo.com'); const session = await s.login('bia@exemplo.com', 'Notebook', '10.0.0.1');
    const userId = (db.raw.prepare("SELECT id FROM users WHERE email = 'bia@exemplo.com'").get() as { id: string }).id;
    db.raw.exec('DELETE FROM sync_state'); // recomeça: o seed cria as linhas
    db.raw.prepare("INSERT INTO users (id, email, email_verified_at, created_at) VALUES ('usr_zz','z@exemplo.com','2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z')").run();
    return { s, db, session, userId };
  }
  const seedFor = (db: ReturnType<typeof legacy>, userId: string) => {
    const mem = db.raw;
    mem.prepare('INSERT INTO sync_state (user_id, revision, updated_at, settings_rev) VALUES (?, 40, ?, 0)').run(userId, '2026-11-01T10:00:00.000Z');
    mem.prepare('INSERT INTO ingredients (user_id,id,name,unit,purchase_quantity,purchase_price,density_g_per_ml,grams_per_unit,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId, 'i0', 'Farinha', 'kg', 1, 6, 0.5, null, 1, null);
    mem.prepare('INSERT INTO recipes (user_id,id,name,yield,packaging_per_unit,labor_total,extra_total,desired_margin,prep_minutes,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(userId, 'r0', 'Bolo', 10, 1, 10, 2, 30, null, 2, null);
    mem.prepare('INSERT INTO recipe_items (user_id,recipe_id,position,ingredient_id,quantity,unit) VALUES (?,?,?,?,?,?)').run(userId, 'r0', 0, 'i0', 500, 'g');
    for (let o = 0; o < 5; o++) {
      mem.prepare('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(userId, `o${o}`, `Cliente ${o}`, 'r0', 2, 40, 10, '2026-12-01', 'Confirmado', `2026-11-0${1 + o}T10:00:00.000Z`, 3.5, '2026-11-01T10:00:00.000Z', 3 + o, null);
      if (o % 2 === 0) mem.prepare('INSERT INTO order_payments (user_id,order_id,position,id,amount,received_at,method,note) VALUES (?,?,?,?,?,?,?,?)').run(userId, `o${o}`, 0, `p${o}`, 25, '2026-11-12', 'Pix', null);
    }
  };
  const money = (db: ReturnType<typeof legacy>) => JSON.stringify([
    db.raw.prepare('SELECT id, quantity, unit_price, deposit, cost_per_unit, cost_captured_at, status, created_at, delivery_date, customer FROM orders ORDER BY id').all(),
    db.raw.prepare('SELECT order_id, position, id, amount, received_at, method FROM order_payments ORDER BY order_id, position').all()]);

  it('Worker novo com o esquema ANTIGO falha fechado e não grava; aplicar todas as migrações antes do Worker', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    const A = new Device(s, session);
    expect((await A.sync()).status).toBe('error'); // a leitura também detecta a ausência da tabela necessária
    A.edit(d => ({ ...d, ingredients: [...d.ingredients, { id: 'novo', name: 'Novo', unit: 'g', purchaseQuantity: 1, purchasePrice: 1 }] }));
    const r = await A.sync();
    expect(r.status).not.toBe('synced'); // gravar (push) falha: o INSERT usa colunas que ainda não existem
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ingredients WHERE id = 'novo'").get()).toEqual({ n: 0 }); // nada foi gravado pela metade
    expect(A.data.ingredients.map(i => i.id)).toContain('novo'); // e a alteração continua guardada no aparelho
  });

  it('Worker novo lê encomendas legadas após aplicar as migrações 0010 e 0011', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql')); db.raw.exec(sql('0009_admin.sql')); db.raw.exec(sql('0010_packagings.sql')); db.raw.exec(sql('0011_order_packaging_charge.sql'));
    // O código do Worker antigo é o mesmo mas sem as colunas novas no INSERT: simulamos gravando como ele grava (sem quote_code/catalog_ref).
    db.raw.prepare('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(userId, 'antigo-1', 'X', 'r0', 1, 10, 0, '2026-12-01', 'Orçamento', '2026-11-12T10:00:00.000Z', null, null, 99, null);
    db.raw.prepare('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(userId, 'antigo-2', 'Y', 'r0', 1, 10, 0, '2026-12-01', 'Orçamento', '2026-11-12T10:00:00.000Z', null, null, 100, null);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NULL").get()).toMatchObject({ n: 7 });
    const A = new Device(s, session); expect((await A.sync()).status).toBe('synced');
    expect(A.data.orders).toHaveLength(7); expect(A.data.orders.every(o => o.quoteCode === undefined)).toBe(true);
  });

  it('banco migrado + Worker novo + app novo: pedidos antigos recebem código derivado, únicos, e NENHUM dado financeiro muda', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql')); db.raw.exec(sql('0009_admin.sql')); db.raw.exec(sql('0010_packagings.sql')); db.raw.exec(sql('0011_order_packaging_charge.sql'));
    const before = money(db);
    const A = new Device(s, session), B = new Device(s, await s.login('bia@exemplo.com', 'Celular', '10.0.0.2'));
    await A.sync(); expect(A.data.orders).toHaveLength(5);
    A.edit(d => ({ ...d, orders: withQuoteCodes(d.orders) })); // o app preenche ao carregar
    expect((await A.sync()).status).toBe('synced');
    const codes = (db.raw.prepare('SELECT id, quote_code FROM orders ORDER BY id').all() as { id: string; quote_code: string }[]);
    expect(codes.every(c => isQuoteCode(c.quote_code))).toBe(true); expect(new Set(codes.map(c => c.quote_code)).size).toBe(codes.length);
    expect(codes.map(c => c.quote_code)).toEqual(A.data.orders.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(o => o.quoteCode)); expect(codes[0].quote_code).toBe(legacyQuoteCode('o0'));
    expect(money(db)).toBe(before); // valores, sinal, recebimentos, custo registrado e datas: idênticos
    await B.sync(); B.edit(d => ({ ...d, orders: withQuoteCodes(d.orders) })); await B.sync(); // segundo aparelho: mesmo código, sem conflito
    expect(B.data.orders.map(o => o.quoteCode)).toEqual(A.data.orders.map(o => o.quoteCode)); expect(B.meta.conflicts).toEqual([]);
    expect(money(db)).toBe(before);
  });

  it('isolamento: a migração e o preenchimento não misturam contas (códigos iguais em contas diferentes são permitidos)', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql'));
    db.raw.prepare("INSERT INTO sync_state (user_id, revision, updated_at, settings_rev) VALUES ('usr_zz', 5, '2026-11-01T10:00:00.000Z', 0)").run();
    db.raw.prepare("INSERT INTO ingredients (user_id,id,name,unit,purchase_quantity,purchase_price,rev) VALUES ('usr_zz','i0','Outra','g',1,1,1)").run();
    const A = new Device(s, session); await A.sync(); A.edit(d => ({ ...d, orders: withQuoteCodes(d.orders) })); await A.sync();
    expect(A.data.ingredients.map(i => i.name)).not.toContain('Outra'); expect(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = 'usr_zz'").get()).toEqual({ n: 0 });
  });
});

/** Ensaio com o backup REAL de homologação (qualquer estágio), só leitura, em memória: `BACKUP=backups/arquivo.sql npm run rehearse`. */
const backup = process.env.REHEARSE_BACKUP;
describe.skipIf(!backup)('Ensaio com o backup real de homologação (somente leitura; nada remoto)', () => {
  it('detecta as migrações aplicadas, simula só as pendentes e confere contagens, valores, dinheiro e unicidade', () => {
    if (!backup || !existsSync(backup)) throw new Error(`backup não encontrado: ${backup}`);
    const raw = new DatabaseSync(':memory:'); raw.exec(readFileSync(backup, 'utf8')); // cópia em memória: o arquivo nunca é aberto para escrita
    const r = rehearseMigrations(raw);
    process.stdout.write(`\nENSAIO COM O BACKUP ${backup}\n  migrações detectadas (d1_migrations): ${r.applied.join(', ')}\n  migrações simuladas (pendentes):     ${r.pending.join(', ') || 'nenhuma'}\n` +
      r.tables.map(t => `  ${t.name.padEnd(14)} ${String(t.rows).padStart(3)} linhas → ${String(t.rows).padStart(3)} (${t.columns} colunas preexistentes idênticas)`).join('\n') +
      `\n  financeiro: ${r.financial.orders} pedidos e ${r.financial.payments} recebimentos idênticos\n  códigos derivados atribuídos (pedidos sem código): ${r.codesAssigned} (únicos por conta; códigos já existentes preservados)\n`);
    expect([...r.applied, ...r.pending]).toEqual(ALL_FILES());
  });
});

describe('Versões em descompasso: app NOVO contra Worker ANTIGO (o que acontece hoje com `npm run dev:staging` antes da publicação)', () => {
  // O Worker antigo valida com listas fixas de campos e descarta os que não conhece: simulamos isso removendo os campos novos do envio.
  const oldWorker = (b: Record<string, any>) => { for (const i of b.upserts.ingredients) delete i.catalogRef; for (const o of b.upserts.orders) delete o.quoteCode; return b; };
  it('descreve o comportamento observado (sem perda de dados locais)', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.com');
    const A = new Device(s, await s.login('bia@exemplo.com', 'A', '10.0.0.1'), oldWorker);
    A.edit(() => ({ schemaVersion: 3, ingredients: [{ id: 'f', name: 'Farinha', unit: 'kg', purchaseQuantity: 1, purchasePrice: 6, catalogRef: { id: 'farinha-de-trigo', variant: 'padrao', version: '2026.11.1', densityGPerMl: 0.5 } }],
      recipes: [{ id: 'r', name: 'Bolo', yield: 10, items: [{ ingredientId: 'f', quantity: 100, unit: 'g' }], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 30 }],
      orders: [{ id: 'o', quoteCode: 'ORC-K7M42P', customer: 'Ana', recipeId: 'r', quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status: 'Orçamento', createdAt: '2026-11-12T10:00:00.000Z' }] }));
    const r = await A.sync(); const r2 = await A.sync();
    expect([r.status, r2.status]).toEqual(['synced', 'synced']); // o ciclo termina, sem laço de reenvio
    // Comportamento CONHECIDO do descompasso: as duas entidades com campos que o Worker antigo não guarda viram conflitos "falsos" pendentes. Resolva com "Manter minha alteração" depois da atualização.
    expect(A.meta.conflicts.filter(c => c.pending).map(c => c.kind).sort()).toEqual(['ingredients', 'orders']);
    expect(A.data.orders[0].quoteCode).toBe('ORC-K7M42P'); expect(A.data.ingredients[0].catalogRef).toBeDefined(); // nada se perde no aparelho
    expect(s.table('orders')[0].quote_code).toBeNull(); // mas o Worker antigo não guarda os campos novos
  });
});
