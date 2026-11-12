import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BoundStatement, D1Like } from '../../worker/src/store';

// `node:sqlite` só existe com prefixo; createRequire evita que o bundler tente resolvê-lo.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Simula o D1 com SQLite real (node:sqlite) aplicando a migração verdadeira do projeto. */
export function createTestD1(opts: { /** aplica só as migrações até este arquivo (inclusive), ex.: '0006_prep_minutes.sql' */ upTo?: string } = {}) {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../../worker/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) { if (opts.upTo && file > opts.upTo) break; db.exec(readFileSync(new URL(file, dir), 'utf8')); }
  type Bound = BoundStatement & { exec: () => { meta: { changes: number } } };
  const d1: D1Like = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...values: unknown[]): Bound {
          const params = values as (string | number | null)[];
          return {
            first: async <T,>() => { const row = stmt.get(...params); return (row ? { ...row } : null) as T | null; },
            run: async () => ({ meta: { changes: Number(stmt.run(...params).changes) } }),
            all: async <T,>() => ({ results: stmt.all(...params).map(r => ({ ...r })) as T[] }),
            exec: () => ({ meta: { changes: Number(stmt.run(...params).changes) } }),
          };
        },
      };
    },
    // Como no D1: transação atômica. Se qualquer instrução falhar, tudo é desfeito.
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = (statements as Bound[]).map(s => s.exec()); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { d1, raw: db, rows: () => db.prepare('SELECT * FROM quotes').all().map(r => ({ ...r })) as Record<string, string | null>[] };
}
