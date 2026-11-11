/**
 * Envio de e-mail (necessário para o login por código). Abstração + adaptadores.
 *
 * NENHUM provedor de produção foi escolhido ou contratado: sem `EMAIL_ADAPTER`, o remetente é "não configurado",
 * o login responde 503 e nada finge ter sido entregue. O adaptador `dev` apenas imprime a mensagem no terminal do
 * `wrangler dev` (para testar localmente) e NÃO entrega nada: nunca use em produção.
 */
export type OutgoingEmail = { to: string; subject: string; text: string };
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

export function createEmailSender(env: object): EmailSender {
  return (env as { EMAIL_ADAPTER?: string }).EMAIL_ADAPTER === 'dev' ? devSender : unconfigured;
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
