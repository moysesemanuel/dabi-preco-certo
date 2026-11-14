import { useMemo, useState } from 'react';
import { Copy, MessageCircle, Send } from 'lucide-react';
import { useAccount } from '../../account/AccountContext';
import { withQuoteCodes } from '../../../shared/quoteCode';
import { computeTotals, formatCents, formatDate, formatQuantity } from '../../../shared/publicQuote';
import { addDays } from '../../domain/schedule';
import type { Order } from '../../domain/types';
import { Field } from '../../components/Field';
import { MoneyInput } from '../../components/MoneyInput';
import { parseMoneyInput } from '../../domain/money';
import { copyText, localToday, type PageProps } from '../../utils';
import { buildPublicQuote, QUOTE_MESSAGES, whatsappShareUrl } from './quotes';

type Props = Pick<PageProps, 'data' | 'update' | 'inform' | 'focus'> & { order: Order; /** código de atendimento permanente do pedido */ code: string; onClose: () => void };

/** Prévia + publicação do orçamento por link. O orçamento público nunca leva custo, margem nem dados do cliente. */
export function QuoteSharePanel({ order, code, data, update, inform, focus, onClose }: Props) {
  const acc = useAccount();
  const [validUntil, setValidUntil] = useState(addDays(localToday(), 7));
  const [fee, setFee] = useState('');
  const [discount, setDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState<{ url: string } | null>(null);

  const built = useMemo(() => buildPublicQuote({ ...order, quoteCode: code }, data.recipes.find(r => r.id === order.recipeId), data.settings, {
    issuedAt: localToday(), validUntil: validUntil || undefined, deliveryFee: fee.trim() ? parseMoneyInput(fee) : undefined, discount: discount.trim() ? parseMoneyInput(discount) : undefined, notes,
  }), [order, data, validUntil, fee, discount, notes]);

  if (!acc.entitled) return <div className="notice warn" style={{ marginTop: 8 }}>Para gerar um link de orçamento, entre na sua conta com licença ativa em <button type="button" className="secondary" style={{ minHeight: 32, padding: '4px 10px' }} onClick={() => focus('settings')}>Configurações</button>. O botão “Copiar orçamento” continua disponível sem conta.</div>;

  async function publish() {
    if (!acc.quotes || !built.ok) return;
    setBusy(true); setError('');
    // Garante que o código do pedido esteja gravado (encomendas antigas) antes de o link existir; o código não muda ao publicar nem republicar.
    if (!order.quoteCode) update(d => ({ ...d, orders: withQuoteCodes(d.orders) }));
    const r = await acc.quotes.publish(built.quote);
    setBusy(false);
    if (r.ok) { setPublished({ url: r.value.url }); inform('Link gerado.'); } else setError(QUOTE_MESSAGES[r.reason]);
  }

  if (published && built.ok) {
    return <div className="stack" style={{ marginTop: 8 }}>
      <div className="notice"><strong>Link gerado.</strong> Envie ao cliente:<br /><span style={{ wordBreak: 'break-all', fontWeight: 700 }}>{published.url}</span></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="secondary" onClick={() => void copyText(published.url).then(ok => inform(ok ? 'Link copiado.' : 'Não foi possível copiar automaticamente. Selecione e copie o link acima.'))}><Copy size={15} /> Copiar link</button>
        <a className="secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderRadius: 11, border: '1px solid var(--color-border)', color: 'var(--color-text)', fontWeight: 700 }} href={whatsappShareUrl(built.quote, published.url)} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} /> Compartilhar no WhatsApp</a>
        <button className="secondary" onClick={onClose}>Fechar</button></div>
      <p className="footnote" style={{ margin: 0 }}>Você pode ver e revogar seus links em Configurações.</p>
    </div>;
  }

  const t = built.ok ? computeTotals(built.quote) : null;
  return <div className="stack" style={{ marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
    <strong>Orçamento por link</strong>
    <div className="form-grid">
      <Field label="Válido até"><input type="date" value={validUntil} min={localToday()} onChange={e => setValidUntil(e.target.value)} /></Field>
      <Field label="Taxa de entrega (R$)"><MoneyInput value={fee} onValueChange={setFee} /></Field>
      <Field label="Desconto (R$)"><MoneyInput value={discount} onValueChange={setDiscount} /></Field>
    </div>
    <Field label="Observações (aparecem no orçamento)"><textarea value={notes} maxLength={1000} rows={3} onChange={e => setNotes(e.target.value)} placeholder="Ex.: Reserva sujeita à confirmação" style={{ width: '100%', border: '1px solid var(--color-border)', borderRadius: 10, padding: 10, font: 'inherit' }} /></Field>

    {built.ok && t ? <div className="formula" aria-label="Prévia do orçamento">
      <strong>{built.quote.businessName}</strong>
      <span className="muted">Orçamento nº {built.quote.quoteNumber} · emitido em {formatDate(built.quote.issuedAt)}{built.quote.validUntil ? ` · válido até ${formatDate(built.quote.validUntil)}` : ''}</span>
      {built.quote.items.map((i, k) => <div key={k} className="formula-row"><span>{i.quantity === 1 ? i.description : `${formatQuantity(i.quantity)} × ${i.description} (${formatCents(i.unitPriceCents)})`}</span><strong>{formatCents(t.lines[k].lineTotalCents)}</strong></div>)}
      {t.deliveryFeeCents > 0 && <div className="formula-row"><span>Entrega</span><strong>{formatCents(t.deliveryFeeCents)}</strong></div>}
      {t.discountCents > 0 && <div className="formula-row"><span>Desconto</span><strong>− {formatCents(t.discountCents)}</strong></div>}
      <div className="formula-row" style={{ fontSize: 17 }}><strong>Total</strong><strong>{formatCents(t.totalCents)}</strong></div>
      {built.quote.notes && <span className="muted">Obs.: {built.quote.notes}</span>}
      {built.quote.businessPhone ? <span className="muted">O telefone do negócio ficará visível no orçamento.</span> : <span className="muted">Sem telefone do negócio: o cliente não verá o botão de WhatsApp (informe em Configurações).</span>}
    </div> : <div className="notice warn">{built.ok ? '' : built.error}</div>}

    <div className="notice warn"><strong>Antes de publicar, saiba que:</strong>
      <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
        <li>o link é uma <strong>cópia</strong> do orçamento de agora: alterar a encomenda depois não atualiza o que o cliente vê;</li>
        <li><strong>qualquer pessoa com o link</strong> pode ver o orçamento; não coloque dados confidenciais nas observações;</li>
        <li>o orçamento <strong>não tem assinatura nem autenticação</strong>: não é um documento aprovado pelo cliente;</li>
        <li>você pode <strong>revogar</strong> o link depois (Configurações), mas não dá para desfazer o que já foi visto.</li></ul>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0 0', fontWeight: 600 }}><input type="checkbox" style={{ width: 18, height: 18 }} checked={understood} onChange={e => setUnderstood(e.target.checked)} /> Entendi</label></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="primary" disabled={busy || !built.ok || !understood} onClick={() => void publish()}><Send size={16} /> {busy ? 'Gerando…' : 'Gerar link'}</button><button className="secondary" onClick={onClose}>Cancelar</button></div>
  </div>;
}
