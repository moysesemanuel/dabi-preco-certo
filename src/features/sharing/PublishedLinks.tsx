import { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { useAccount } from '../../account/AccountContext';
import { formatCents } from '../../../shared/publicQuote';
import { copyText, brDate } from '../../utils';
import { QUOTE_MESSAGES, type PublishedQuote } from './quotes';

const STATUS: Record<PublishedQuote['status'], { label: string; cls: string }> = { active: { label: 'Ativo', cls: 'tag green' }, expired: { label: 'Validade encerrada', cls: 'tag orange' }, revoked: { label: 'Revogado', cls: 'tag red' } };

export function PublishedLinks({ inform, quoteNumber }: { inform: (m: string) => void; quoteNumber?: string }) {
  const acc = useAccount();
  const [list, setList] = useState<PublishedQuote[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!acc.quotes) return;
    const r = await acc.quotes.list();
    if (r.ok) { setList(r.value); setError(''); } else setError(QUOTE_MESSAGES[r.reason]);
  }, [acc.quotes]);
  useEffect(() => { if (acc.entitled) void load(); }, [acc.entitled, load]);
  if (!acc.entitled || !acc.quotes) return null;
  const quotes = acc.quotes;
  const visible = quoteNumber ? (list ?? []).filter(q => q.quoteNumber === quoteNumber) : list;

  async function revoke(q: PublishedQuote) {
    if (!confirm(`Revogar o link do orçamento ${q.quoteNumber}? Quem abrir o link verá que ele foi retirado. Isto não pode ser desfeito.`)) return;
    const r = await quotes.revoke(q.id);
    if (r.ok) { inform('Link revogado.'); void load(); } else inform(QUOTE_MESSAGES[r.reason]);
  }
  return <section className="card stack"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><h2 className="section-title" style={{ margin: 0 }}>{quoteNumber ? 'Links deste pedido' : 'Links de orçamentos publicados'}</h2><button className="inline-icon" aria-label="Atualizar lista" title="Atualizar" onClick={() => void load()}><RefreshCw size={16} /></button></div>
    <p className="muted">Quem tem o link vê o orçamento. Revogar retira o link do ar; o que já foi visto não pode ser desfeito.</p>
    {error && <div className="notice warn">{error}</div>}
    {visible && !visible.length && <div className="empty"><Link2 size={30} />{quoteNumber ? 'Nenhum link publicado para este pedido.' : 'Nenhum link publicado ainda.'}</div>}
    {visible?.map(q => <div key={q.id} style={{ border: '1px solid var(--color-border)', borderRadius: 12, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><strong>{/^ORC-/.test(q.quoteNumber) ? q.quoteNumber : `Nº ${q.quoteNumber}`} · {formatCents(q.totalCents)}</strong><span className={STATUS[q.status].cls}>{STATUS[q.status].label}</span></div>
      <p className="muted" style={{ margin: '4px 0 8px', fontSize: 13 }}>Emitido em {brDate(q.issuedAt)}{q.validUntil ? ` · válido até ${brDate(q.validUntil)}` : ''}</p>
      {q.status !== 'revoked' && q.url && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="secondary" onClick={() => void copyText(q.url!).then(ok => inform(ok ? 'Link copiado.' : 'Não foi possível copiar automaticamente.'))}><Copy size={15} /> Copiar link</button>
        <a className="secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderRadius: 11, border: '1px solid var(--color-border)', color: 'var(--color-text)', fontWeight: 700 }} href={q.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Abrir</a>
        <button className="secondary" onClick={() => void revoke(q)}><Trash2 size={15} /> Revogar</button></div>}
    </div>)}
  </section>;
}
