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

/** Impressão digital das colunas ANTIGAS de uma tabela (ignora as colunas novas), para provar que nada existente mudou. */
const fingerprint = (db: InstanceType<typeof DatabaseSync>, table: string, skip: string[] = []) => {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name).filter(c => !skip.includes(c));
  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${cols.slice(0, 2).join(', ')}`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};
const TABLES = ['quotes', 'licenses', 'rate_limits', 'users', 'sessions', 'auth_codes', 'sync_state', 'ingredients', 'recipes', 'recipe_items', 'orders', 'order_payments'];
const NEW_COLS: Record<string, string[]> = { ingredients: ['catalog_ref'], orders: ['quote_code'] };

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
  it('são aditivas: nenhuma linha, coluna antiga ou valor existente muda; as colunas novas nascem vazias', () => {
    const db = legacy(); seedLegacy(db.raw);
    const before = Object.fromEntries(TABLES.map(t => [t, { n: (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, fp: fingerprint(db.raw, t) }]));
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql'));
    for (const t of TABLES) {
      expect((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(before[t].n);
      expect(fingerprint(db.raw, t, NEW_COLS[t] ?? []), t).toBe(before[t].fp);
    }
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM ingredients WHERE catalog_ref IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NOT NULL').get()).toEqual({ n: 0 });
    expect(before.orders.n).toBeGreaterThan(10);
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
    expect(readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()).toEqual(['0001_quotes.sql', '0002_licenses.sql', '0003_accounts.sql', '0004_data.sql', '0005_payments.sql', '0006_prep_minutes.sql', '0007_catalog_ref.sql', '0008_quote_code.sql']);
    for (const f of ['0007_catalog_ref.sql', '0008_quote_code.sql']) expect(sql(f), f).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b|UPDATE\s+\w+\s+SET/i);
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

  it('Worker novo com o esquema ANTIGO (publicar o Worker antes da migração) falha nos envios; por isso a ordem é migração → Worker → app', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    const A = new Device(s, session);
    expect((await A.sync()).status).toBe('synced'); // ler (pull) funciona: SELECT * não depende das colunas novas
    A.edit(d => ({ ...d, ingredients: [...d.ingredients, { id: 'novo', name: 'Novo', unit: 'g', purchaseQuantity: 1, purchasePrice: 1 }] }));
    const r = await A.sync();
    expect(r.status).not.toBe('synced'); // gravar (push) falha: o INSERT usa colunas que ainda não existem
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ingredients WHERE id = 'novo'").get()).toEqual({ n: 0 }); // nada foi gravado pela metade
    expect(A.data.ingredients.map(i => i.id)).toContain('novo'); // e a alteração continua guardada no aparelho
  });

  it('Worker ANTIGO com o esquema novo (migrar antes de publicar) continua funcionando: as colunas novas são opcionais e o índice ignora NULL', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql'));
    // O código do Worker antigo é o mesmo mas sem as colunas novas no INSERT: simulamos gravando como ele grava (sem quote_code/catalog_ref).
    db.raw.prepare('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(userId, 'antigo-1', 'X', 'r0', 1, 10, 0, '2026-12-01', 'Orçamento', '2026-11-12T10:00:00.000Z', null, null, 99, null);
    db.raw.prepare('INSERT INTO orders (user_id,id,customer,recipe_id,quantity,unit_price,deposit,delivery_date,status,created_at,cost_per_unit,cost_captured_at,rev,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(userId, 'antigo-2', 'Y', 'r0', 1, 10, 0, '2026-12-01', 'Orçamento', '2026-11-12T10:00:00.000Z', null, null, 100, null);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NULL").get()).toMatchObject({ n: 7 });
    const A = new Device(s, session); expect((await A.sync()).status).toBe('synced'); // o Worker novo lê pedidos sem código sem erro
    expect(A.data.orders).toHaveLength(7); expect(A.data.orders.every(o => o.quoteCode === undefined)).toBe(true);
  });

  it('banco migrado + Worker novo + app novo: pedidos antigos recebem código derivado, únicos, e NENHUM dado financeiro muda', async () => {
    const { s, db, session, userId } = await legacyServer(); seedFor(db, userId);
    db.raw.exec(sql('0007_catalog_ref.sql')); db.raw.exec(sql('0008_quote_code.sql'));
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

/** Ensaio com o backup REAL de homologação, só leitura, em memória: `REHEARSE_BACKUP=backups/arquivo.sql npm run rehearse`. */
const backup = process.env.REHEARSE_BACKUP;
describe.skipIf(!backup)('Ensaio com o backup real de homologação (somente leitura; nada remoto)', () => {
  it('restaura em banco descartável, aplica 0007 e 0008 e confere que nada mudou', () => {
    if (!backup || !existsSync(backup)) throw new Error(`backup não encontrado: ${backup}`);
    const raw = new DatabaseSync(':memory:'); raw.exec(readFileSync(backup, 'utf8'));
    const applied = (raw.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]).map(r => r.name);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'").all() as { name: string }[]).map(t => t.name);
    const count = (t: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = Object.fromEntries(tables.map(t => [t, { n: count(t), fp: fingerprint(raw, t) }]));
    const pending = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && !applied.includes(f)).sort();
    for (const f of pending) raw.exec(sql(f));
    for (const t of tables) { expect(count(t), t).toBe(before[t].n); expect(fingerprint(raw, t, NEW_COLS[t] ?? []), t).toBe(before[t].fp); }
    const orders = raw.prepare('SELECT user_id, id, created_at FROM orders').all() as { user_id: string; id: string; created_at: string }[];
    const codes = new Map<string, string>(); const used = new Set<string>();
    for (const o of orders) { let salt = 0, c = legacyQuoteCode(o.id, salt); while (used.has(`${o.user_id}:${c}`)) c = legacyQuoteCode(o.id, ++salt); used.add(`${o.user_id}:${c}`); codes.set(o.id, c); }
    for (const [id, c] of codes) raw.prepare('UPDATE orders SET quote_code = ? WHERE id = ?').run(c, id); // o que o app enviaria no primeiro sync: nenhuma violação do índice único
    process.stdout.write(`\nENSAIO COM O BACKUP: migrações já aplicadas no dump = ${applied.length} (${applied.join(', ')}); pendentes aplicadas no ensaio = ${pending.join(', ') || 'nenhuma'}\n` +
      tables.map(t => `  ${t.padEnd(14)} ${String(before[t].n).padStart(3)} linhas → ${String(count(t)).padStart(3)} (colunas antigas idênticas)`).join('\n') + `\n  pedidos com código derivado único: ${codes.size}\n`);
    expect(pending).toEqual(['0007_catalog_ref.sql', '0008_quote_code.sql']);
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
