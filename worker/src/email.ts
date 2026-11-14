/**
 * Envio de e-mail (necessário para o login por código). Abstração + adaptadores.
 *
 * NENHUM provedor de produção foi escolhido ou contratado: sem `EMAIL_ADAPTER`, o remetente é "não configurado",
 * o login responde 503 e nada finge ter sido entregue. O adaptador `dev` apenas imprime a mensagem no terminal do
 * `wrangler dev` (para testar localmente) e NÃO entrega nada: nunca use em produção.
 */
export type OutgoingEmail = { to: string; subject: string; text: string; /** Versão HTML opcional (a texto continua obrigatória). */ html?: string };
/** Falha de envio com motivo genérico (nunca inclui token, código nem resposta do provedor). `retryAfterSeconds` vem do provedor em 429. */
export class EmailSendError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}
export interface EmailSender {
  /** false quando não há provedor real/dev configurado. */
  readonly configured: boolean;
  send(message: OutgoingEmail): Promise<void>;
}

const devSender: EmailSender = {
  configured: true,
  async send(m) { console.log(`[e-mail DE DESENVOLVIMENTO, não entregue]\nPara: ${m.to}\nAssunto: ${m.subject}\n${m.text}`); },
};
const unconfigured: EmailSender = { configured: false, async send() { throw new Error('EMAIL_NOT_CONFIGURED'); } };

export type EmailEnv = { ALLOWED_ORIGINS?: string; EMAIL_ADAPTER?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string };
export const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 8000;
/** Remetente aceito: `email@dominio` ou `Nome <email@dominio>`, sem quebras de linha (evita injeção de cabeçalhos). */
const FROM_PATTERN = /^(?:[^<>\r\n@]{1,80} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;
const looksLikeAddress = (v: string) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v);

/**
 * Adaptador Resend (https://resend.com/docs/api-reference/emails/send-email). O token vem SEMPRE do segredo do ambiente
 * (`RESEND_API_KEY`, via `wrangler secret put`), nunca do repositório nem do app. Erros NUNCA incluem o token, o corpo da mensagem
 * (que contém o código) nem a resposta do provedor: só um motivo genérico para o log. `fetchFn` é injetável para testes.
 */
export function createResendSender(apiKey: string, from: string, fetchFn: typeof fetch = fetch): EmailSender {
  return {
    configured: true,
    async send(m) {
      if (!looksLikeAddress(m.to) || /[\r\n]/.test(m.subject)) throw new Error('EMAIL_INVALID_MESSAGE');
      let res: Response;
      try {
        res = await fetchFn(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
          signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        });
      } catch { throw new EmailSendError('EMAIL_PROVIDER_UNREACHABLE'); }
      // Qualquer resposta que não seja 2xx é falha (inclusive 429 e 5xx do provedor). Não se lê o corpo: pode ecoar dados.
      if (!res.ok) {
        const retry = Number(res.headers.get('retry-after'));
        throw new EmailSendError(`EMAIL_PROVIDER_REJECTED_${res.status}`, res.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 3600) : undefined);
      }
    },
  };
}

export function createEmailSender(env: object, fetchFn?: typeof fetch): EmailSender {
  const e = env as EmailEnv;
  if (e.EMAIL_ADAPTER === 'dev') {
    // O adaptador de desenvolvimento escreve o CÓDIGO no log: só vale quando todas as origens autorizadas são locais.
    const origins = (e.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
    const local = origins.length > 0 && origins.every(o => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o));
    return local ? devSender : unconfigured;
  }
  if (e.EMAIL_ADAPTER === 'resend') {
    // Configuração incompleta ou inválida = "não configurado" (503), nunca um envio parcial.
    if (!e.RESEND_API_KEY || !e.EMAIL_FROM || !FROM_PATTERN.test(e.EMAIL_FROM)) return unconfigured;
    return createResendSender(e.RESEND_API_KEY, e.EMAIL_FROM, fetchFn);
  }
  return unconfigured;
}

/** Para testes: guarda as mensagens em memória. */
export class MemoryEmailSender implements EmailSender {
  readonly configured = true;
  outbox: OutgoingEmail[] = [];
  failNext = false;
  async send(message: OutgoingEmail): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('falha simulada'); }
    this.outbox.push(message);
  }
  /** Último código de 8 dígitos enviado. */
  lastCode(): string | undefined { return this.outbox.at(-1)?.text.match(/\b\d{8}\b/)?.[0]; }
}
