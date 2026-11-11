/** Mensagem do código de acesso: versão texto simples e HTML responsivo (tabelas e estilos inline, compatível com clientes de e-mail). */
export type LoginEmailContent = { subject: string; text: string; html: string };

export function loginCodeEmail(code: string, ttlMinutes: number): LoginEmailContent {
  if (!/^\d{8}$/.test(code)) throw new Error('Código inválido para o e-mail.'); // só dígitos entram no HTML: nada a escapar
  const ttl = Math.max(1, Math.floor(ttlMinutes));
  const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
  const text = `Seu código de acesso ao PedidoCerto: ${code}\n\nEle vale por ${ttl} minutos e só pode ser usado uma vez.\nSe você não pediu este código, ignore esta mensagem: ninguém entra na sua conta sem ele.\nNunca compartilhe este código com ninguém.`;
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Seu código de acesso</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;">
<tr><td style="padding:28px 24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#1f2937;">Pedido<span style="color:#e8840c;">Certo</span></td></tr>
<tr><td style="padding:8px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#374151;">Use o código abaixo para entrar na sua conta:</td></tr>
<tr><td align="center" style="padding:16px 24px;"><div style="font-family:'Courier New',Courier,monospace;font-size:34px;line-height:44px;letter-spacing:4px;font-weight:bold;color:#111827;background:#fff4e5;border-radius:10px;padding:12px 8px;">${spaced}</div></td></tr>
<tr><td style="padding:0 24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#4b5563;">O código vale por ${ttl} minutos e só pode ser usado uma vez.</td></tr>
<tr><td style="padding:0 24px 28px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#6b7280;">Se você não pediu este código, ignore esta mensagem: ninguém entra na sua conta sem ele. Nunca compartilhe este código com ninguém.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: 'Seu código de acesso ao PedidoCerto', text, html };
}
