import { describe, expect, it, vi } from 'vitest';
import { computeTotals } from '../shared/publicQuote';
import type { Order, Recipe, Settings } from '../src/domain/types';
import { buildPublicQuote, createQuotesClient, QUOTE_MESSAGES, quoteNumberOf, toCents, whatsappShareUrl } from '../src/features/sharing/quotes';
import { makeServer } from './helpers/server';

const order = (over: Partial<Order> = {}): Order => ({ id: '7f3a9c2e-1111-4222-8333-444455556666', quoteCode: 'ORC-K7M42P', customer: 'Maria Cliente Secreta', recipeId: 'r', quantity: 2, unitPrice: 65, deposit: 10, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', costSnapshot: { costPerUnit: 31.5, capturedAt: '2026-11-11T10:00:00.000Z' }, ...over });
const recipe: Recipe = { id: 'r', name: 'Bolo de chocolate', yield: 10, items: [{ ingredientId: 'f', quantity: 500 }], packagingPerUnit: 1, laborTotal: 20, extraTotal: 7, desiredMargin: 37.5 };
const settings: Settings = { cupSizeMl: 240, businessName: 'Doces da Bia', businessPhone: '5541999990000' };
const opts = { issuedAt: '2026-11-11', validUntil: '2026-11-15' };

describe('Montagem do orçamento público', () => {
  it('traz só o que o cliente pode ver e calcula os totais', () => {
    const r = buildPublicQuote(order(), recipe, settings, { ...opts, deliveryFee: 15, discount: 5, notes: ' Reserva sujeita à confirmação ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote).toEqual({ version: 1, quoteNumber: 'ORC-K7M42P', businessName: 'Doces da Bia', businessPhone: '5541999990000', issuedAt: '2026-11-11', validUntil: '2026-11-15', items: [{ description: 'Bolo de chocolate', quantity: 2, unitPriceCents: 6500 }], deliveryFeeCents: 1500, discountCents: 500, notes: 'Reserva sujeita à confirmação' });
    expect(computeTotals(r.quote)).toMatchObject({ subtotalCents: 13000, totalCents: 14000 });
  });
  it('NUNCA inclui custo, margem, dados do cliente, sinal, ids internos ou preço de compra', () => {
    const r = buildPublicQuote(order(), recipe, settings, opts);
    if (!r.ok) throw new Error(r.error);
    const text = JSON.stringify(r.quote);
    for (const secret of ['Maria', 'Secreta', '31.5', '31,5', 'costSnapshot', 'costPerUnit', 'desiredMargin', '37.5', 'margin', 'deposit', 'customer', 'laborTotal', 'purchasePrice', '7f3a9c2e-1111', '"10"']) expect(text, secret).not.toContain(secret);
    expect(Object.keys(r.quote).sort()).toEqual(['businessName', 'businessPhone', 'issuedAt', 'items', 'quoteNumber', 'validUntil', 'version']);
  });
  it('valores monetários viram centavos sem erro de ponto flutuante', () => {
    expect([toCents(6.9), toCents(0.1 + 0.2), toCents(19.99), toCents(1.005), toCents(0)]).toEqual([690, 30, 1999, 101, 0]);
    const r = buildPublicQuote(order({ unitPrice: 6.9, quantity: 3 }), recipe, settings, opts);
    if (!r.ok) throw new Error(r.error); expect(computeTotals(r.quote).totalCents).toBe(2070);
  });
  it('inclui embalagens adicionais no orçamento público sem expor custos internos', () => {
    const r = buildPublicQuote(order({ quantity: 25, unitPrice: 2.5, packagingCharge: 3.75, packagingItems: [{ packagingId: 'box', name: 'Caixa', quantity: 1, unitCost: 3.75 }] }), recipe, settings, opts);
    if (!r.ok) throw new Error(r.error);
    expect(computeTotals(r.quote).totalCents).toBe(6625);
    expect(r.quote.items).toEqual([
      { description: 'Bolo de chocolate', quantity: 25, unitPriceCents: 250 },
      { description: 'Embalagens adicionais', quantity: 1, unitPriceCents: 375 },
    ]);
    expect(JSON.stringify(r.quote)).not.toContain('unitCost');
    expect(JSON.stringify(r.quote)).not.toContain('packagingId');
  });
  it('exige o nome do negócio e a receita; sem telefone, o orçamento sai sem WhatsApp', () => {
    expect(buildPublicQuote(order(), recipe, { cupSizeMl: 240 }, opts)).toMatchObject({ ok: false, error: expect.stringContaining('nome do negócio') });
    expect(buildPublicQuote(order(), recipe, undefined, opts)).toMatchObject({ ok: false });
    expect(buildPublicQuote(order(), undefined, settings, opts)).toMatchObject({ ok: false, error: expect.stringContaining('receita') });
    const noPhone = buildPublicQuote(order(), recipe, { cupSizeMl: 240, businessName: 'Bia' }, opts);
    expect(noPhone.ok && 'businessPhone' in noPhone.quote).toBe(false);
  });
  it('rejeita dados inválidos com mensagem clara', () => {
    expect(buildPublicQuote(order(), recipe, settings, { ...opts, validUntil: '2026-11-01' })).toMatchObject({ ok: false, error: expect.stringContaining('validade') });
    expect(buildPublicQuote(order(), recipe, settings, { ...opts, discount: 9999 })).toMatchObject({ ok: false, error: expect.stringContaining('desconto') });
    expect(buildPublicQuote(order(), recipe, { ...settings, businessPhone: '123' }, opts)).toMatchObject({ ok: false, error: expect.stringContaining('telefone') });
    expect(buildPublicQuote(order(), recipe, settings, { ...opts, notes: 'x'.repeat(1001) })).toMatchObject({ ok: false });
    expect(buildPublicQuote(order({ quantity: 0 }), recipe, settings, opts)).toMatchObject({ ok: false });
  });
  it('número do orçamento estável e legível; mensagem do WhatsApp codificada', () => {
    expect(quoteNumberOf({ id: '7f3a9c2e-1111', quoteCode: 'ORC-K7M42P' })).toBe('ORC-K7M42P'); // o número é o código permanente
    expect(quoteNumberOf({ id: '7f3a9c2e-1111' })).toMatch(/^ORC-[A-Z2-9]{6}$/); expect(quoteNumberOf({ id: '7f3a9c2e-1111' })).not.toContain('7F3A9C'); // pedido antigo: derivado, nunca o id
    const r = buildPublicQuote(order(), recipe, { ...settings, businessName: 'A&B Doces #1' }, opts);
    if (!r.ok) throw new Error(r.error);
    const url = whatsappShareUrl(r.quote, 'https://orcamento.exemplo.test/o/abc?x=1&y=2');
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toBe('Olá! Segue seu orçamento da A&B Doces #1, nº ORC-K7M42P. Acesse: https://orcamento.exemplo.test/o/abc?x=1&y=2');
    expect(url).not.toMatch(/text=[^%]*[&#]/); // & e # do texto não podem quebrar a URL
  });
});

describe('Cliente de orçamentos', () => {
  const BASE = 'https://api.exemplo.test';
  const fake = (status: number, body: unknown = {}, headers = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  const quote = (() => { const r = buildPublicQuote(order(), recipe, settings, opts); if (!r.ok) throw new Error(r.error); return r.quote; })();
  it('publicar, listar e revogar mapeiam os erros do servidor', async () => {
    const c = (f: typeof fetch) => createQuotesClient(BASE, () => 'csrf', f);
    expect(await c(fake(201, { id: 'ABC', url: 'https://orcamento.exemplo.test/o/ABC' })).publish(quote)).toEqual({ ok: true, value: { id: 'ABC', url: 'https://orcamento.exemplo.test/o/ABC' } });
    expect(await c(fake(201, { id: 'ABC' })).publish(quote)).toEqual({ ok: true, value: { id: 'ABC', url: `${BASE}/o/ABC` } });
    expect(await c(fake(429, { error: 'QUOTA_ACTIVE_EXCEEDED' })).publish(quote)).toEqual({ ok: false, reason: 'quota-active' });
    expect(await c(fake(429, { error: 'QUOTA_DAILY_EXCEEDED' })).publish(quote)).toEqual({ ok: false, reason: 'quota-daily' });
    expect(await c(fake(429, { error: 'RATE_LIMITED' }, { 'retry-after': '30' })).publish(quote)).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 30 });
    expect(await c(fake(401, {})).publish(quote)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await c(fake(403, { error: 'CSRF' })).publish(quote)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(await c(fake(403, { error: 'LICENSE_REVOKED' })).publish(quote)).toEqual({ ok: false, reason: 'no-license' });
    expect(await c(fake(400, {})).publish(quote)).toEqual({ ok: false, reason: 'invalid' });
    expect(await c(fake(500, {})).revoke('ABC')).toMatchObject({ ok: false, reason: 'unexpected' });
    expect(await c(vi.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch).list()).toEqual({ ok: false, reason: 'network' });
    for (const r of ['network', 'unauthorized', 'no-license', 'quota-active', 'quota-daily', 'rate-limited', 'invalid', 'unexpected'] as const) expect(QUOTE_MESSAGES[r].length).toBeGreaterThan(10);
  });
  it('só envia o CSRF ao publicar e revogar', async () => {
    const f = fake(200, { quotes: [] });
    const c = createQuotesClient(BASE, () => 'tok', f);
    await c.list(); await c.revoke('ABC'); await c.publish(quote);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u.replace(BASE, '')}`)).toEqual(['GET /api/quotes', 'DELETE /api/quotes/ABC', 'POST /api/quotes']);
    expect(calls.map(([, i]) => (i.headers as Record<string, string>)['X-CSRF-Token'])).toEqual([undefined, 'tok', 'tok']);
  });
});

describe('Publicar contra o Worker real', () => {
  it('publica, lista, a página pública mostra o orçamento SEM dados internos e a revogação a tira do ar', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.com');
    const session = await s.login('bia@exemplo.com');
    const client = createQuotesClient('https://api.exemplo.test', () => session.csrf, s.fetchFor(session));
    const built = buildPublicQuote(order(), recipe, settings, { ...opts, deliveryFee: 15, notes: 'Reserva sujeita à confirmação' });
    if (!built.ok) throw new Error(built.error);
    const pub = await client.publish(built.quote);
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect(pub.value.url).toMatch(/^https:\/\/api\.exemplo\.test\/o\/[A-Za-z0-9_-]{22}$/);
    const page = await (await s.request('GET', `/o/${pub.value.id}`)).text();
    for (const text of ['Doces da Bia', '2 × Bolo de chocolate', 'R$ 145,00', 'Reserva sujeita à confirmação']) expect(page).toContain(text);
    for (const secret of ['Maria', 'Secreta', 'Margem', 'desiredMargin', 'Custo', '31,5', 'costSnapshot']) expect(page).not.toContain(secret); // ('margin' existe no CSS e a marca Custô integra a página
    expect(await client.list()).toMatchObject({ ok: true, value: [{ id: pub.value.id, status: 'active', quoteNumber: 'ORC-K7M42P', totalCents: 14500 }] });
    expect((await client.revoke(pub.value.id)).ok).toBe(true);
    expect((await s.request('GET', `/o/${pub.value.id}`)).status).toBe(410);
    expect(await client.list()).toMatchObject({ ok: true, value: [{ status: 'revoked' }] });
  });
  it('sem sessão a publicação falha com "unauthorized" e nada é criado', async () => {
    const s = makeServer();
    const client = createQuotesClient('https://api.exemplo.test', () => undefined, s.fetchFor());
    const built = buildPublicQuote(order(), recipe, settings, opts);
    if (!built.ok) throw new Error(built.error);
    expect(await client.publish(built.quote)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(s.table('quotes')).toHaveLength(0);
  });
});
