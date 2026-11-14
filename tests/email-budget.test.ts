import { beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_DAILY_LIMIT_DEFAULT } from '../worker/src/accounts';
import { makeServer, type Server } from './helpers/server';

// Cota do Resend (plano gratuito): 100 e-mails/dia (dia UTC) e 3.000/mês. O Worker mantém um orçamento diário próprio, mais baixo, e
// um teto por e-mail, para que ninguém consiga gastar a cota inteira pedindo códigos.
let s: Server;
beforeEach(() => { s = makeServer(new Date('2026-11-12T00:05:00Z')); });
const ask = (email: string, ip = '10.0.0.1') => s.request('POST', '/api/auth/request-code', { body: { email }, ip });
const at = (iso: string) => { s.state.clock = new Date(iso); };

describe('Orçamento diário de e-mails de código de acesso', () => {
  it('o padrão (80) fica abaixo dos 100/dia do plano gratuito do Resend', () => { expect(EMAIL_DAILY_LIMIT_DEFAULT).toBeLessThan(100); expect(EMAIL_DAILY_LIMIT_DEFAULT).toBeGreaterThan(0); });

  it('depois do limite do dia nenhum e-mail é enviado, a resposta é igual para qualquer e-mail (não revela clientes) e traz Retry-After até a meia-noite UTC', async () => {
    s.env.EMAIL_DAILY_LIMIT = '3';
    for (const n of [1, 2, 3, 4]) await s.issueFor(`cliente${n}@exemplo.com`);
    for (const n of [1, 2, 3]) expect((await ask(`cliente${n}@exemplo.com`, `10.0.0.${n}`)).status).toBe(202);
    expect(s.mail.outbox).toHaveLength(3);
    const licensed = await ask('cliente4@exemplo.com', '10.0.1.1'), unknown = await ask('desconhecido@exemplo.com', '10.0.1.2');
    for (const r of [licensed, unknown]) { expect(r.status).toBe(503); expect((await r.json() as { error: string }).error).toBe('EMAIL_DAILY_BUDGET'); }
    expect(Number(licensed.headers.get('retry-after'))).toBe(Number(unknown.headers.get('retry-after')));
    expect(Number(licensed.headers.get('retry-after'))).toBe(24 * 3600 - 5 * 60); // 00:05 UTC → faltam 23h55
    expect(s.mail.outbox).toHaveLength(3); // nada saiu para o provedor
  });

  it('o orçamento zera à meia-noite UTC (como a cota diária do Resend)', async () => {
    s.env.EMAIL_DAILY_LIMIT = '1'; await s.issueFor('a@exemplo.com'); await s.issueFor('b@exemplo.com');
    expect((await ask('a@exemplo.com')).status).toBe(202); expect((await ask('b@exemplo.com', '10.0.0.2')).status).toBe(503);
    at('2026-11-12T23:59:00Z'); expect((await ask('b@exemplo.com', '10.0.0.3')).status).toBe(503);
    at('2026-11-13T00:00:30Z'); expect((await ask('b@exemplo.com', '10.0.0.4')).status).toBe(202);
    expect(s.mail.outbox).toHaveLength(2);
  });

  it('só e-mails realmente enviados gastam o orçamento: e-mail sem licença e pedidos dentro do intervalo mínimo não gastam', async () => {
    s.env.EMAIL_DAILY_LIMIT = '2'; await s.issueFor('a@exemplo.com');
    for (let n = 0; n < 5; n++) expect((await ask(`ninguem${n}@exemplo.com`, `10.9.0.${n}`)).status).toBe(202); // sem conta: resposta igual, nenhum e-mail
    expect((await ask('a@exemplo.com')).status).toBe(202); expect((await ask('a@exemplo.com')).status).toBe(202); // o segundo cai no intervalo de 60 s
    expect(s.mail.outbox).toHaveLength(1);
    expect((await ask('a@exemplo.com', '10.0.0.5')).status).toBe(202); expect(s.mail.outbox).toHaveLength(1);
  });

  it('um pico simultâneo não passa do limite (consumo atômico)', async () => {
    s.env.EMAIL_DAILY_LIMIT = '5';
    const emails = Array.from({ length: 20 }, (_, n) => `c${n}@exemplo.com`); for (const e of emails) await s.issueFor(e);
    const results = await Promise.all(emails.map((e, n) => ask(e, `10.2.0.${n}`)));
    expect(s.mail.outbox.length).toBeLessThanOrEqual(5);
    expect(results.filter(r => r.status === 202).length).toBeGreaterThanOrEqual(s.mail.outbox.length);
  });

  it('valor inválido em EMAIL_DAILY_LIMIT volta ao padrão seguro (nunca "sem limite")', async () => {
    await s.issueFor('a@exemplo.com');
    for (const bad of ['0', '-5', 'abc', '1e9', '']) { s.env.EMAIL_DAILY_LIMIT = bad; s.state.clock = new Date(s.state.clock.getTime() + 2 * 60_000); expect((await ask('a@exemplo.com', `10.8.0.${bad.length}${bad.charCodeAt(0) || 0}`)).status).toBe(202); }
    const { windowCount } = await import('../worker/src/store');
    expect(await windowCount(s.env.DB, 'global', 'email-send-day', 86400, s.state.clock.getTime())).toBeGreaterThan(0); // o orçamento continua sendo contado
  });
});

describe('Teto diário por e-mail', () => {
  it('um único cliente não pode receber mais de 12 códigos por dia, mesmo respeitando o limite de 5 por hora', async () => {
    await s.issueFor('vitima@exemplo.com'); let sent = 0, blocked = 0;
    for (let i = 0; i < 24; i++) {
      at(new Date(Date.UTC(2026, 10, 12, 0, 5) + i * 13 * 60_000).toISOString()); // um pedido a cada 13 min (≈ 4,6 por hora: abaixo do limite por hora)
      const r = await ask('vitima@exemplo.com', `10.3.0.${i}`);
      if (r.status === 202) sent++; else { blocked++; expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBeTruthy(); }
    }
    expect(s.mail.outbox).toHaveLength(12); expect(blocked).toBe(24 - 12); expect(sent).toBe(12);
  });
  it('no dia seguinte volta a funcionar', async () => {
    await s.issueFor('v@exemplo.com');
    for (let i = 0; i < 14; i++) { at(new Date(Date.UTC(2026, 10, 12, 0, 5) + i * 13 * 60_000).toISOString()); await ask('v@exemplo.com', `10.4.0.${i}`); }
    const before = s.mail.outbox.length; at('2026-11-13T01:00:00Z');
    expect((await ask('v@exemplo.com', '10.4.9.9')).status).toBe(202); expect(s.mail.outbox.length).toBe(before + 1);
  });
});

describe('Limpeza dos contadores', () => {
  it('a limpeza de uma janela não apaga contadores de OUTRO escopo (o limite diário sobrevive à virada da hora)', async () => {
    const { consumeRateLimit, windowCount } = await import('../worker/src/store');
    const t = Date.UTC(2026, 10, 12, 1, 0, 0);
    await consumeRateLimit(s.env.DB, 'k', 'dia', 10, 86400, t);
    await consumeRateLimit(s.env.DB, 'k', 'hora', 10, 3600, t);
    await consumeRateLimit(s.env.DB, 'k', 'hora', 10, 3600, t + 3600_000); // nova hora: limpa só as horas antigas
    expect(await windowCount(s.env.DB, 'k', 'dia', 86400, t + 3600_000)).toBe(1);
  });
});
