/** Interface mínima do D1 usada aqui (compatível com D1Database do Cloudflare e com o simulador dos testes). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ meta: { changes?: number } }>;
    };
  };
}

export type QuoteRow = { id: string; payload: string; created_at: string; updated_at: string; revoked_at: string | null; owner_id: string | null };

/** Identificador público: 16 bytes aleatórios (128 bits) em base64url, 22 caracteres. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Todas as consultas usam parâmetros (bind); nenhum valor é concatenado no SQL.
export const getQuote = (db: D1Like, id: string) =>
  db.prepare('SELECT id, payload, created_at, updated_at, revoked_at, owner_id FROM quotes WHERE id = ?').bind(id).first<QuoteRow>();

export async function insertQuote(db: D1Like, row: { id: string; payload: string; now: string; ownerId: string }): Promise<void> {
  await db.prepare('INSERT INTO quotes (id, payload, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?)').bind(row.id, row.payload, row.now, row.now, row.ownerId).run();
}

export async function updateQuotePayload(db: D1Like, id: string, ownerId: string, payload: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE quotes SET payload = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(payload, now, id, ownerId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function revokeQuote(db: D1Like, id: string, ownerId: string, now: string): Promise<boolean> {
  const r = await db.prepare('UPDATE quotes SET revoked_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').bind(now, now, id, ownerId).run();
  return (r.meta.changes ?? 0) > 0;
}
