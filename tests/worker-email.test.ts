import { describe, expect, it, vi } from 'vitest';
import { createEmailSender, createResendSender, EmailSendError, RESEND_URL } from '../worker/src/email';
import { loginCodeEmail } from '../worker/src/emailTemplates';
import { createHandler } from '../worker/src/index';
import { createLicenseAuthorizer } from '../worker/src/auth';
import { createCompositeAuthorizer, createSessionAuthorizer } from '../worker/src/session';
import { issueLicenseSql } from '../worker/src/licenseAdmin';
import { generateLicenseId, generateLicenseKey, hashLicenseKey } from '../worker/src/licenses';
import { BASE, ORIGIN, SECRET } from './helpers/server';
import { createTestD1 } from './helpers/d1';

// API do Resend SIMULADA: nenhum teste faz requisição de rede, usa token real nem envia e-mail.
const TOKEN = 're_token_falso_somente_para_teste_123456';
const FROM = 'DaBi Preço Certo <acesso@mail.dabitech.com.br>'; // remetente real do domínio verificado (só o texto; nada é enviado)
const msg = { to: 'bia@exemplo.test', subject: 'Seu código de acesso', text: 'Seu código de acesso: 12345678' };
const ok = () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
type Call = { url: string; init: RequestInit };
const fakeFetch = (respond: (c: Call) => Response | Promise<Response>) => { const calls: Call[] = []; const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond({ url, init }); }) as unknown as typeof fetch; return { f, calls }; };

describe('Adaptador Resend', () => {
  it('envia para a API do Resend com o token no cabeçalho Authorization e o corpo esperado', async () => {
    const { f, calls } = fakeFetch(ok);
    await createResendSender(TOKEN, FROM, f).send(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_URL);
    expect(RESEND_URL.startsWith('https://')).toBe(true);
    const init = calls[0].init;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, to: ['bia@exemplo.test'], subject: msg.subject, text: msg.text });
    expect(init.body).not.toContain(TOKEN); // o token só vai no cabeçalho
  });

  it.each([400, 401, 403, 422, 429, 500, 503])('resposta %s do provedor vira falha, sem vazar token, código nem corpo da resposta', async status => {
    const { f } = fakeFetch(() => new Response(`erro ${TOKEN} 12345678 bia@exemplo.test`, { status }));
    const err = await createResendSender(TOKEN, FROM, f).send(msg).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`EMAIL_PROVIDER_REJECTED_${status}`);
    expect(String((err as Error).stack)).not.toContain(TOKEN);
  });

  it('falha de rede e tempo esgotado viram falha genérica', async () => {
    const boom = (async () => { throw new TypeError(`falha ao conectar com ${TOKEN}`); }) as unknown as typeof fetch;
    const err = await createResendSender(TOKEN, FROM, boom).send(msg).catch(e => e as Error);
    expect((err as Error).message).toBe('EMAIL_PROVIDER_UNREACHABLE');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('pede um limite de tempo (AbortSignal) em cada envio', async () => {
    const { f, calls } = fakeFetch(ok);
    await createResendSender(TOKEN, FROM, f).send(msg);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('recusa destinatário malformado ou assunto com quebra de linha (injeção de cabeçalho) sem chamar a API', async () => {
    const { f, calls } = fakeFetch(ok);
    const s = createResendSender(TOKEN, FROM, f);
    for (const bad of [{ ...msg, to: 'a@b.test, outra@pessoa.test' }, { ...msg, to: 'sem-arroba' }, { ...msg, to: 'a@b.test\r\nBcc: x@y.test' }, { ...msg, subject: 'ola\r\nBcc: x@y.test' }]) {
      await expect(s.send(bad)).rejects.toThrow('EMAIL_INVALID_MESSAGE');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Modelo do e-mail de login', () => {
  const m = loginCodeEmail('01234567', 10);
  it('traz texto simples e HTML responsivo com o mesmo código', () => {
    expect(m.subject).toBe('Seu código de acesso ao Custô');
    expect(m.text).toContain('Seu código de acesso ao Custô');
    expect(m.html).toContain('>Custô</td>');
    expect(m.text).toContain('01234567'); expect(m.text).toContain('10 minutos');
    expect(m.html).toContain('0123 4567'); expect(m.html).toContain('name="viewport"'); expect(m.html).toContain('max-width:480px');
    expect(m.html).not.toMatch(/<script|<img|<a |https?:\/\//i); // sem rastreamento, scripts nem links
  });
  it('só aceita código de 8 dígitos (nada de texto livre no HTML)', () => {
    for (const bad of ['1234567', '123456789', '1234567a', '<b>123456', '']) expect(() => loginCodeEmail(bad, 10)).toThrow();
  });
  it('o Resend recebe html e text juntos', async () => {
    const { f, calls } = fakeFetch(ok);
    await createResendSender(TOKEN, FROM, f).send({ to: 'bia@exemplo.test', ...m });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.html).toBe(m.html); expect(body.text).toBe(m.text);
  });
  it('429 do Resend: repassa o tempo de espera (limitado a 1 hora) e outros erros não levam tempo', async () => {
    const a = await createResendSender(TOKEN, FROM, fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '30' } })).f).send(msg).catch(e => e);
    expect(a).toBeInstanceOf(EmailSendError); expect(a.retryAfterSeconds).toBe(30);
    const b = await createResendSender(TOKEN, FROM, fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '999999' } })).f).send(msg).catch(e => e);
    expect(b.retryAfterSeconds).toBe(3600);
    const c = await createResendSender(TOKEN, FROM, fakeFetch(() => new Response('', { status: 500, headers: { 'retry-after': '30' } })).f).send(msg).catch(e => e);
    expect(c.retryAfterSeconds).toBeUndefined();
  });
});

describe('Escolha do adaptador a partir do ambiente', () => {
  it('sem EMAIL_ADAPTER, ou resend incompleto/inválido: não configurado (nada é enviado)', async () => {
    const { f, calls } = fakeFetch(ok);
    for (const env of [{}, { EMAIL_ADAPTER: 'resend' }, { EMAIL_ADAPTER: 'resend', RESEND_API_KEY: TOKEN }, { EMAIL_ADAPTER: 'resend', EMAIL_FROM: FROM }, { EMAIL_ADAPTER: 'resend', RESEND_API_KEY: TOKEN, EMAIL_FROM: 'inválido\r\nBcc: x@y.test' }, { EMAIL_ADAPTER: 'outro', RESEND_API_KEY: TOKEN, EMAIL_FROM: FROM }]) {
      const s = createEmailSender(env, f);
      expect(s.configured).toBe(false);
      await expect(s.send(msg)).rejects.toThrow('EMAIL_NOT_CONFIGURED');
    }
    expect(calls).toHaveLength(0);
  });
  it('resend completo é configurado e aceita remetente simples ou com nome', () => {
    expect(createEmailSender({ EMAIL_ADAPTER: 'resend', RESEND_API_KEY: TOKEN, EMAIL_FROM: FROM }).configured).toBe(true);
    expect(createEmailSender({ EMAIL_ADAPTER: 'resend', RESEND_API_KEY: TOKEN, EMAIL_FROM: 'acesso@exemplo.test' }).configured).toBe(true);
  });
  it('o adaptador "dev" (que escreve o código no log) só vale com origens locais', () => {
    expect(createEmailSender({ EMAIL_ADAPTER: 'dev', ALLOWED_ORIGINS: 'http://localhost:5174' }).configured).toBe(true);
    expect(createEmailSender({ EMAIL_ADAPTER: 'dev', ALLOWED_ORIGINS: 'https://app.exemplo.com.br' }).configured).toBe(false);
    expect(createEmailSender({ EMAIL_ADAPTER: 'dev', ALLOWED_ORIGINS: 'http://localhost:5174,https://app.exemplo.com.br' }).configured).toBe(false);
    expect(createEmailSender({ EMAIL_ADAPTER: 'dev' }).configured).toBe(false);
  });
});

describe('Login por código usando o Resend simulado', () => {
  const NOW = new Date('2026-11-12T15:00:00Z');
  async function setup(respond: (c: Call) => Response | Promise<Response>) {
    const db = createTestD1();
    const { f, calls } = fakeFetch(respond);
    const env = { DB: db.d1, PUBLIC_BASE_URL: BASE, ALLOWED_ORIGINS: ORIGIN, AUTH_SECRET: SECRET, EMAIL_ADAPTER: 'resend', RESEND_API_KEY: TOKEN, EMAIL_FROM: FROM };
    const handle = createHandler({ authorize: createCompositeAuthorizer(createLicenseAuthorizer(), createSessionAuthorizer()), now: () => NOW, email: e => createEmailSender(e, f) });
    db.raw.exec(issueLicenseSql({ id: generateLicenseId(), keyHash: await hashLicenseKey(generateLicenseKey()), email: 'bia@exemplo.test', quotaActive: 100, quotaDaily: 30, now: NOW.toISOString() }));
    const request = (path: string, body: unknown) => handle(new Request(`${BASE}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    return { db, calls, request };
  }

  it('o código sai pelo Resend e permite entrar; o token nunca aparece na resposta', async () => {
    const { calls, request } = await setup(ok);
    const r = await request('/api/auth/request-code', { email: 'bia@exemplo.test' });
    expect(r.status).toBe(202);
    expect(await r.text()).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.to).toEqual(['bia@exemplo.test']);
    const code = sent.text.match(/\b\d{8}\b/)[0];
    const v = await request('/api/auth/verify-code', { email: 'bia@exemplo.test', code });
    expect(v.status).toBe(200);
  });

  it('e-mail sem licença: mesma resposta e NENHUMA chamada ao Resend', async () => {
    const { calls, request } = await setup(ok);
    const r = await request('/api/auth/request-code', { email: 'estranho@exemplo.test' });
    expect(r.status).toBe(202);
    expect(calls).toHaveLength(0);
  });

  it('falha do Resend: 503 claro, sem vazar token, e o código não enviado é descartado (não pode ser usado)', async () => {
    const { db, calls, request } = await setup(() => new Response('{"message":"quota"}', { status: 429 }));
    const r = await request('/api/auth/request-code', { email: 'bia@exemplo.test' });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBeNull();
    const text = await r.text();
    expect(text).toContain('EMAIL_SEND_FAILED');
    expect(text).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    const code = JSON.parse(calls[0].init.body as string).text.match(/\b\d{8}\b/)[0];
    const v = await request('/api/auth/verify-code', { email: 'bia@exemplo.test', code });
    expect(v.status).toBe(401);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('o código enviado não é registrado no log do servidor', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls, request } = await setup(ok);
    await request('/api/auth/request-code', { email: 'bia@exemplo.test' });
    const code = JSON.parse(calls[0].init.body as string).text.match(/\b\d{8}\b/)[0];
    for (const s of [spy, err]) expect(JSON.stringify(s.mock.calls)).not.toContain(code);
    vi.restoreAllMocks();
  });
});
