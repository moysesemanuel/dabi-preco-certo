import { LIMITS } from '../../shared/publicQuote';

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

export function respond(body: BodyInit | null, status: number, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': contentType, ...extra } });
}
export const json = (data: unknown, status = 200) => respond(JSON.stringify(data), status, 'application/json; charset=utf-8');
export const apiError = (status: number, error: string, message: string, extra: Record<string, string> = {}) => respond(JSON.stringify({ error, message }), status, 'application/json; charset=utf-8', extra);
export const html = (body: string, status = 200, head = false) => respond(head ? null : body, status, 'text/html; charset=utf-8');

/** Lê o corpo JSON com limite real de tamanho (não confia só no Content-Length). */
export async function readJsonBody(request: Request, maxBytes: number = LIMITS.maxBodyBytes): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, status: 413, error: 'BODY_TOO_LARGE' };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: 'INVALID_JSON' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: 'BODY_TOO_LARGE' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'INVALID_JSON' };
  } finally {
    reader.releaseLock();
  }
}

