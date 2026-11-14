import { computeTotals, formatCents, formatDate, formatQuantity, whatsappContactUrl, type PublicQuote } from '../../shared/publicQuote';

/** Escapa texto para HTML. Todo dado do orçamento passa por aqui; nunca se insere HTML bruto. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root{--background:#F7F9F7;--surface:#FFFFFF;--primary:#0B4F4A;--primary-hover:#083E3A;--text:#1F2326;--muted:#586660;--border:#D5E1DB;--accent:#FF6B4A;--success:#176744;--shadow:#173D3014}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 6px 25px var(--shadow)}
.head{background:var(--primary);color:var(--surface);padding:24px 20px;text-align:center}
.quote-logo{display:block;width:142px;max-width:70%;height:auto;margin:0 auto 18px}
.head h1{margin:0;font-size:22px;letter-spacing:-.02em;word-break:break-word}
.meta{padding:18px 20px;border-bottom:1px solid var(--border);font-size:14px;color:var(--muted)}
.meta strong{display:block;font-size:17px;color:var(--text);margin-bottom:4px}
.badge{display:inline-block;margin-top:8px;padding:4px 10px;border-radius:99px;background:#FFF3E1;color:#80530A;font-size:12px;font-weight:700}
section{padding:18px 20px;border-bottom:1px solid var(--border)}
h2{margin:0 0 12px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--primary)}
.item{padding:10px 0;border-bottom:1px solid var(--border)}.item:last-child{border-bottom:0}
.item b{display:block;word-break:break-word}.item span{display:block;font-size:14px;color:var(--muted)}
.row{display:flex;justify-content:space-between;gap:12px;padding:4px 0}
.total{font-size:20px;font-weight:800;padding-top:12px;margin-top:8px;border-top:2px solid var(--primary)}
.notes{white-space:normal;word-break:break-word;color:var(--muted);font-size:15px}
.btn{display:block;text-align:center;margin:20px;padding:14px;border-radius:12px;background:var(--primary);color:var(--surface);text-decoration:none;font-weight:800}.btn:hover{background:var(--primary-hover)}.btn:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.foot{padding:16px 4px;font-size:12px;color:var(--muted);text-align:center}
@media (min-width:600px){.wrap{padding:32px 16px}}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0B4F4A"><link rel="icon" type="image/svg+xml" href="/brand/favicon-custo-orange.svg"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return shell(title, `<div class="card"><section><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></section></div>`);
}

export function renderQuotePage(quote: PublicQuote, opts: { expired: boolean }): string {
  const t = computeTotals(quote);
  const items = quote.items.map((item, i) => `<div class="item"><b>${item.quantity === 1 ? escapeHtml(item.description) : `${escapeHtml(formatQuantity(item.quantity))} × ${escapeHtml(item.description)}`}</b><span>${item.quantity === 1 ? 'Valor' : 'Valor unitário'}: ${formatCents(item.unitPriceCents)}</span><span>Subtotal: ${formatCents(t.lines[i].lineTotalCents)}</span></div>`).join('');
  const notes = quote.notes ? `<section><h2>Observações</h2><div class="notes">${escapeHtml(quote.notes).replace(/\n/g, '<br>')}</div></section>` : '';
  const wa = whatsappContactUrl(quote);
  const button = wa ? `<a class="btn" href="${escapeHtml(wa)}" rel="noopener noreferrer">Falar pelo WhatsApp</a>` : '';
  const body = `<div class="card">
<div class="head"><img class="quote-logo" src="/brand/custo-color.svg" alt="Custô"><h1>${escapeHtml(quote.businessName)}</h1></div>
<div class="meta"><strong>ORÇAMENTO Nº ${escapeHtml(quote.quoteNumber)}</strong>Emitido em: ${formatDate(quote.issuedAt)}${quote.validUntil ? `<br>Válido até: ${formatDate(quote.validUntil)}` : ''}${opts.expired ? '<br><span class="badge">Validade encerrada: confirme valores com o vendedor</span>' : ''}</div>
<section><h2>Produtos</h2>${items}</section>
<section>
<div class="row"><span>Subtotal</span><span>${formatCents(t.subtotalCents)}</span></div>
${quote.deliveryFeeCents ? `<div class="row"><span>Entrega</span><span>${formatCents(t.deliveryFeeCents)}</span></div>` : ''}
${quote.discountCents ? `<div class="row"><span>Desconto</span><span>− ${formatCents(t.discountCents)}</span></div>` : ''}
<div class="row total"><span>TOTAL</span><span>${formatCents(t.totalCents)}</span></div>
</section>
${notes}${button}</div>
<p class="foot">Orçamento criado com Custô e publicado pelo vendedor. Valores e disponibilidade sujeitos à confirmação. Não é documento fiscal, contrato nem comprovante de pagamento.</p>`;
  return shell(`Orçamento nº ${quote.quoteNumber} · ${quote.businessName}`, body);
}
