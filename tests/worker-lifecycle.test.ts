import { describe, expect, it } from 'vitest';
import { emptyPush } from '../shared/sync';
import type { PublicQuote } from '../shared/publicQuote';
import { revokeLicenseSessionsSql, setLicenseStatusSql } from '../worker/src/licenseAdmin';
import { makeServer } from './helpers/server';

const DAY = 86_400_000;
const quote = (): PublicQuote => ({ version: 1, quoteNumber: '001', businessName: 'Doces da Bia', issuedAt: '2026-11-11', items: [{ description: 'Bolo', quantity: 1, unitPriceCents: 5000 }] });
const at = (s: ReturnType<typeof makeServer>, days: number, extraMs = 0) => { s.state.clock = new Date(new Date('2026-11-12T15:00:00Z').getTime() + days * DAY + extraMs); };
const alive = async (s: ReturnType<typeof makeServer>, ses: Awaited<ReturnType<ReturnType<typeof makeServer>['login']>>) => (await s.request('GET', '/api/auth/session', { session: ses })).status === 200;

describe('Revogação de licença: nenhuma operação protegida passa', () => {
  async function setup() {
    const s = makeServer();
    const id = await s.issueFor('bia@exemplo.test');
    const ses = await s.login('bia@exemplo.test');
    const created = await (await s.request('POST', '/api/quotes', { session: ses, body: quote() })).json() as { id: string };
    return { s, id, ses, quoteId: created.id };
  }
  it('com a licença revogada, TODAS as rotas protegidas respondem 403 LICENSE_REVOKED e nada é gravado', async () => {
    const { s, id, ses, quoteId } = await setup();
    s.db.raw.exec(setLicenseStatusSql(id, 'revoked', s.state.clock.toISOString()));
    const before = JSON.stringify(s.table('quotes'));
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/sync/v2'], ['POST', '/api/sync/v2/push', emptyPush(0)],
      ['POST', '/api/quotes', quote()], ['PUT', `/api/quotes/${quoteId}`, quote()], ['DELETE', `/api/quotes/${quoteId}`],
      ['GET', '/api/quotes'], ['GET', '/api/license'],
    ];
    for (const [m, p, body] of attempts) {
      const r = await s.request(m, p, { session: ses, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await r.json(), `${m} ${p}`).toMatchObject({ error: 'LICENSE_REVOKED' });
    }
    expect(JSON.stringify(s.table('quotes'))).toBe(before);
    expect(s.table('orders').length + s.table('ingredients').length + s.table('recipes').length).toBe(0);
  });
  it('a revogação vale já na PRÓXIMA requisição de uma sessão que estava aberta e é desfeita se a licença for reativada', async () => {
    const { s, id, ses } = await setup();
    expect((await s.request('GET', '/api/sync/v2', { session: ses })).status).toBe(200);
    s.db.raw.exec(setLicenseStatusSql(id, 'revoked', s.state.clock.toISOString()));
    expect((await s.request('GET', '/api/sync/v2', { session: ses })).status).toBe(403);
    s.db.raw.exec(setLicenseStatusSql(id, 'active', s.state.clock.toISOString()));
    expect((await s.request('GET', '/api/sync/v2', { session: ses })).status).toBe(200);
  });
  it('não entra de novo: nem pedido de código envia e-mail, nem código já enviado abre sessão', async () => {
    const { s, id } = await setup();
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const sent = s.mail.outbox.length; const code = s.mail.lastCode();
    s.db.raw.exec(setLicenseStatusSql(id, 'revoked', s.state.clock.toISOString()));
    at(s, 0, 120_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    expect(s.mail.outbox.length).toBe(sent);
    const v = await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code } });
    expect(v.status).toBe(403);
  });
  it('encerrar as sessões da licença derruba todos os dispositivos (401) e a leitura pública dos links continua valendo até serem revogados', async () => {
    const { s, id, ses, quoteId } = await setup();
    s.db.raw.exec(setLicenseStatusSql(id, 'revoked', s.state.clock.toISOString()));
    s.db.raw.exec(revokeLicenseSessionsSql(id, s.state.clock.toISOString()));
    expect(await alive(s, ses)).toBe(false);
    expect((await s.request('GET', `/api/sync/v2`, { session: ses })).status).toBe(401);
    expect((await s.request('GET', `/o/${quoteId}`)).status).toBe(200); // comportamento documentado: use --revoke-quotes para retirar do ar
  });
  it('conta desativada perde o acesso na hora', async () => {
    const { s, ses } = await setup();
    s.db.raw.exec("UPDATE users SET disabled_at = '2026-11-12T15:00:01.000Z'");
    expect(await alive(s, ses)).toBe(false);
  });
});

describe('Ciclo de vida da sessão', () => {
  it('uso renova a validade (30 dias de inatividade), mas nunca passa de 90 dias desde o login', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const ses = await s.login('bia@exemplo.test');
    for (const d of [20, 40, 60, 80]) { at(s, d); expect(await alive(s, ses), `dia ${d}`).toBe(true); } // sempre usada a cada 20 dias
    at(s, 89.5); expect(await alive(s, ses)).toBe(true);
    at(s, 90, 1000); expect(await alive(s, ses)).toBe(false); // teto absoluto
  });
  it('sem uso por 30 dias a sessão expira, e depois de expirada nenhuma requisição a reativa', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const ses = await s.login('bia@exemplo.test');
    at(s, 29); expect(await alive(s, ses)).toBe(true);
    at(s, 29 + 31); expect(await alive(s, ses)).toBe(false);
    at(s, 29 + 31, 1000); expect(await alive(s, ses)).toBe(false);
  });
  it('sessão revogada não é renovada pelo uso', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const ses = await s.login('bia@exemplo.test');
    await s.request('POST', '/api/auth/logout', { session: ses });
    at(s, 1); expect(await alive(s, ses)).toBe(false);
    expect(s.table('sessions')[0].revoked_at).not.toBeNull();
  });
  it('o cookie dura o máximo absoluto (90 dias); o servidor decide a validade', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const r = await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code: s.mail.lastCode() } });
    expect(r.headers.get('set-cookie')).toContain(`Max-Age=${90 * 86_400}`);
  });
});

describe('Troca de dispositivos', () => {
  it('trocar o dispositivo: o escolhido é encerrado, o outro continua e a nova sessão abre', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const a = await s.login('bia@exemplo.test', 'Celular'); const b = await s.login('bia@exemplo.test', 'Notebook');
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' }, ip: '1.1.1.1' }); at(s, 0, 61_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const code = s.mail.lastCode();
    const full = await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code } });
    expect(full.status).toBe(409);
    const ok = await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code, deviceLabel: 'Tablet', replaceSessionId: a.sessionId } });
    expect(ok.status).toBe(200);
    expect(await alive(s, a)).toBe(false); expect(await alive(s, b)).toBe(true);
    expect(s.table('sessions').filter(x => x.revoked_at === null)).toHaveLength(2);
  });
  it('tentativa de troca com código errado NÃO derruba o dispositivo escolhido', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const a = await s.login('bia@exemplo.test', 'Celular'); await s.login('bia@exemplo.test', 'Notebook');
    at(s, 0, 61_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const wrong = s.mail.lastCode() === '00000000' ? '11111111' : '00000000';
    const r = await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code: wrong, replaceSessionId: a.sessionId } });
    expect(r.status).toBe(401);
    expect(await alive(s, a)).toBe(true);
  });
  it('reutilizar o mesmo código para trocar de novo falha e não derruba mais ninguém', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    const a = await s.login('bia@exemplo.test'); const b = await s.login('bia@exemplo.test');
    at(s, 0, 61_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const code = s.mail.lastCode();
    expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code, replaceSessionId: a.sessionId } })).status).toBe(200);
    expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code, replaceSessionId: b.sessionId } })).status).toBe(401);
    expect(await alive(s, b)).toBe(true);
  });
});

describe('Falhas e limites no envio de códigos', () => {
  it('intervalo de 60 s: pedido repetido não envia outro e-mail nem invalida o primeiro código; depois do intervalo, envia', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    expect((await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } })).status).toBe(202);
    const first = s.mail.lastCode();
    expect((await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } })).status).toBe(202);
    expect(s.mail.outbox).toHaveLength(1);
    expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code: first } })).status).toBe(200);
    at(s, 0, 61_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    expect(s.mail.outbox).toHaveLength(2);
  });
  it('falha de envio: 503, nada de código válido e o pedido seguinte (sem esperar) pode tentar de novo', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    s.mail.failNext = true;
    const r = await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    expect(r.status).toBe(503);
    expect(s.table('auth_codes').every(c => c.used_at !== null)).toBe(true);
    expect((await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } })).status).toBe(202);
    expect(s.mail.outbox).toHaveLength(1);
  });
  it('código expirado (10 min) é recusado, e a 6ª tentativa nunca é aceita, nem com o código certo', async () => {
    const s = makeServer(); await s.issueFor('bia@exemplo.test');
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const code = s.mail.lastCode()!; const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code: wrong } })).status).toBe(401);
    expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code } })).status).toBe(401);
    at(s, 0, 61_000);
    await s.request('POST', '/api/auth/request-code', { body: { email: 'bia@exemplo.test' } });
    const c2 = s.mail.lastCode(); at(s, 0, 61_000 + 11 * 60_000);
    expect((await s.request('POST', '/api/auth/verify-code', { body: { email: 'bia@exemplo.test', code: c2 } })).status).toBe(401);
  });
});
