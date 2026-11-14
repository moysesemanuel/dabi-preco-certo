import { describe, expect, it } from 'vitest';
import { readJsonBody } from '../worker/src/http';

describe('limite de corpo HTTP', () => {
  it('interrompe a leitura e cancela o stream assim que o tamanho real excede o limite', async () => {
    let canceled = false;
    const chunks = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { canceled = true; },
    });
    const request = new Request('https://example.test/api', { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });

    const result = await readJsonBody(request, 10);

    expect(result).toEqual({ ok: false, status: 413, error: 'BODY_TOO_LARGE' });
    expect(canceled).toBe(true);
  });
});
