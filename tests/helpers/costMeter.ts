import type { DatabaseSync } from 'node:sqlite';
import type { BoundStatement, D1Like } from '../../worker/src/store';

/**
 * Medidor de consumo do D1 para testes locais (SQLite real). Conta o que o plano gratuito limita:
 *  - consultas por invocação do Worker (um `batch()` conta como UMA consulta, como no D1);
 *  - linhas LIDAS (estimativa: linhas devolvidas; varredura completa = linhas da tabela) e ESCRITAS (alterações × (1 + índices) — limite superior).
 * É uma ESTIMATIVA local: o número oficial vem de `meta.rows_read/rows_written` no D1 real. Serve para comparar versões e detectar regressões.
 */
export type Usage = { requests: number; queries: number; batches: number; statements: number; rowsRead: number; rowsWritten: number; scans: string[]; /** maior número de consultas D1 em UMA requisição (limite gratuito: 50 por invocação) */ maxQueriesPerRequest: number };
export const emptyUsage = (): Usage => ({ requests: 0, queries: 0, batches: 0, statements: 0, rowsRead: 0, rowsWritten: 0, scans: [], maxQueriesPerRequest: 0 });

type Tracked = BoundStatement & { sql: string; params: (string | number | null)[]; exec: () => { meta: { changes: number } } };
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;

export function meterD1(inner: D1Like, raw: DatabaseSync) {
  let usage = emptyUsage();
  let inRequest = 0;
  const q = () => { usage.queries++; inRequest++; usage.maxQueriesPerRequest = Math.max(usage.maxQueriesPerRequest, inRequest); };
  const indexCount = new Map<string, number>();
  const indexesOf = (table: string) => {
    if (!indexCount.has(table)) indexCount.set(table, (raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").get(table) as { n: number }).n);
    return indexCount.get(table)!;
  };
  const tableOf = (sql: string) => /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql)?.[1];
  const scanRows = (sql: string, params: (string | number | null)[]): number => {
    try {
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
      let rows = 0;
      for (const p of plan) { const m = /^SCAN (\w+)/.exec(p.detail); if (m && m[1] !== 'json_each' && !/USING/.test(p.detail)) { rows += (raw.prepare(`SELECT COUNT(*) AS n FROM ${m[1]}`).get() as { n: number }).n; usage.scans.push(`${m[1]}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 90)}`); } }
      return rows;
    } catch { return 0; }
  };
  const account = (sql: string, params: (string | number | null)[], returned: number, changes: number) => {
    usage.statements++;
    if (WRITE.test(sql)) { const t = tableOf(sql), n = Math.max(changes, returned); usage.rowsWritten += n * (1 + (t ? indexesOf(t) : 0)); usage.rowsRead += Math.max(n, 1); } // INSERT … RETURNING: as linhas devolvidas são as gravadas
    else usage.rowsRead += Math.max(returned, 1) + scanRows(sql, params);
  };
  const d1: D1Like = {
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...values) as Tracked;
          const params = values as (string | number | null)[];
          const wrapped: Tracked = {
            sql, params, exec: bound.exec,
            first: async <T,>() => { q(); const r = await bound.first<T>(); account(sql, params, r ? 1 : 0, 0); return r; },
            run: async () => { q(); const r = await bound.run(); account(sql, params, 0, r.meta.changes ?? 0); return r; },
            all: async <T,>() => { q(); const r = await bound.all<T>(); account(sql, params, r.results.length, 0); return r; },
          };
          return wrapped;
        },
      };
    },
    async batch(statements) {
      q(); usage.batches++;
      const out = await inner.batch(statements as BoundStatement[]);
      (statements as Tracked[]).forEach((s, i) => account(s.sql, s.params, 0, out[i]?.meta.changes ?? 0));
      return out;
    },
  };
  return { d1, request: () => { usage.requests++; inRequest = 0; }, reset: () => { usage = emptyUsage(); inRequest = 0; }, snapshot: (): Usage => ({ ...usage, scans: [...usage.scans] }) };
}
