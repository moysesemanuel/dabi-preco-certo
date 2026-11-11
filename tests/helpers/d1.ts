import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { D1Like } from '../../worker/src/store';

// `node:sqlite` só existe com prefixo; createRequire evita que o bundler tente resolvê-lo.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Simula o D1 com SQLite real (node:sqlite) aplicando a migração verdadeira do projeto. */
export function createTestD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../worker/migrations/0001_quotes.sql', import.meta.url), 'utf8'));
  const d1: D1Like = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const params = values as (string | number | null)[];
          return {
            first: async <T,>() => { const row = stmt.get(...params); return (row ? { ...row } : null) as T | null; },
            run: async () => ({ meta: { changes: Number(stmt.run(...params).changes) } }),
          };
        },
      };
    },
  };
  return { d1, rows: () => db.prepare('SELECT * FROM quotes').all().map(r => ({ ...r })) as Record<string, string | null>[] };
}
