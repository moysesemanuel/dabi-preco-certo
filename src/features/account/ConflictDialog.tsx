import { useEffect, useId, useState } from 'react';
import { useAccount } from '../../account/AccountContext';
import { Modal } from '../../components/Modal';
import { isOpenFinancial, type ConflictRecord } from '../../sync/engine';
import { conflictName, conflictTitle, diffRows } from '../../sync/describe';
import type { ConflictAction } from '../../sync/resolve';
import { FinancialConflict } from './FinancialConflict';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Comparação lado a lado de um conflito de dados, com confirmação explícita antes de aplicar a escolha. */
function Compare({ c, onDone, inform, packagings }: { c: ConflictRecord; onDone: () => void; inform: (m: string) => void; packagings: import('../../domain/types').Packaging[] }) {
  const acc = useAccount();
  const [confirming, setConfirming] = useState<ConflictAction | null>(null);
  const [error, setError] = useState('');
  const [seenRev] = useState(c.serverRev);
  const changed = c.serverRev !== seenRev;
  const rows = diffRows(c, packagings);
  const localDeleted = c.local === null, cloudDeleted = c.server === null;
  const apply = () => {
    if (!confirming) return;
    try {
      acc.resolveConflict(c.id, confirming, seenRev);
      inform(confirming === 'keep-local' ? 'Sua alteração foi mantida e será enviada à nuvem.' : 'Versão da nuvem aplicada. Sua versão continua guardada no histórico de conflitos.');
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível resolver o conflito.'); setConfirming(null); }
  };
  return <div className="stack" style={{ gap: 14 }}>
    <p className="muted" style={{ margin: 0 }}>{conflictTitle(c)} foi {cloudDeleted ? 'excluído' : 'modificado'} em outro dispositivo e também {localDeleted ? 'excluído' : 'alterado'} aqui. As duas versões estão preservadas; nada foi sobrescrito.</p>
    {changed && <div className="notice warn" role="alert">A versão da nuvem mudou de novo enquanto você decidia. Revise os valores abaixo antes de escolher.</div>}
    <div className="conflict-grid">
      <section className="conflict-card" aria-label="Neste dispositivo"><h3>Neste dispositivo</h3><p className="muted">{localDeleted ? 'Excluído aqui, ainda não enviado.' : 'Alteração salva offline, ainda não enviada.'}</p>
        <dl>{rows.map(r => <div key={r.key}><dt>{r.label}</dt><dd>{r.local}</dd></div>)}</dl></section>
      <section className="conflict-card" aria-label="Na nuvem"><h3>Na nuvem</h3><p className="muted">{cloudDeleted ? 'Excluído em outro dispositivo.' : 'Alteração confirmada pelo servidor'}{c.updatedAt ? ` (atualizada ${when(c.updatedAt)})` : ''}.</p>
        <dl>{rows.map(r => <div key={r.key}><dt>{r.label}</dt><dd>{r.server}</dd></div>)}</dl></section>
    </div>
    {!!c.base && rows.some(r => r.base !== '—') && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Valor antes das alterações: {rows.map(r => `${r.label} ${r.base}`).join('; ')}.</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {!confirming ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="primary" data-autofocus onClick={() => { setError(''); setConfirming('keep-local'); }}>Manter minha alteração</button>
      <button className="secondary" onClick={() => { setError(''); setConfirming('keep-server'); }}>Manter versão da nuvem</button>
    </div> : <div className="notice warn stack" style={{ gap: 10 }} role="alertdialog" aria-label="Confirmar escolha">
      <span>{confirming === 'keep-local'
        ? `Sua versão (${rows.map(r => `${r.label}: ${r.local}`).join('; ')}) será enviada à nuvem e substituirá a versão de lá. Se alguém alterar o registro de novo antes disso, você será avisado e poderá decidir outra vez.`
        : `A versão da nuvem (${rows.map(r => `${r.label}: ${r.server}`).join('; ')}) será aplicada neste dispositivo. Sua alteração deixa de valer aqui, mas continua guardada no histórico de conflitos.`}</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="primary" data-autofocus onClick={apply}>Confirmar</button><button className="secondary" onClick={() => setConfirming(null)}>Voltar</button></div>
    </div>}
  </div>;
}

/** Tela de resolução: percorre os conflitos pendentes (dados e recebimentos). "Decidir depois" não perde nada. */
export function ConflictDialog({ inform, packagings = [] }: { inform: (m: string) => void; packagings?: import('../../domain/types').Packaging[] }) {
  const acc = useAccount();
  const id = useId();
  const items = [...acc.pendingConflicts, ...acc.conflicts.filter(isOpenFinancial)];
  const [i, setI] = useState(0);
  useEffect(() => { if (acc.conflictsOpen && items.length === 0) acc.setConflictsOpen(false); }, [acc, items.length]);
  if (!acc.conflictsOpen || items.length === 0) return null;
  const cur = items[Math.min(i, items.length - 1)];
  const idx = Math.min(i, items.length - 1);
  return <Modal titleId={id} onClose={() => acc.setConflictsOpen(false)} title={<>Resolver conflito — {conflictName(cur)}</>}>
    {items.length > 1 && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <button className="secondary" disabled={idx === 0} onClick={() => setI(idx - 1)}>Anterior</button>
      <span className="muted" role="status">Conflito {idx + 1} de {items.length}</span>
      <button className="secondary" disabled={idx === items.length - 1} onClick={() => setI(idx + 1)}>Próximo</button></div>}
    {isOpenFinancial(cur) ? <FinancialConflict key={cur.id} c={cur} inform={inform} /> : <Compare key={`${cur.id}:${cur.serverRev}`} c={cur} inform={inform} packagings={packagings} onDone={() => setI(0)} />}
    <div style={{ marginTop: 16 }}><button className="secondary" onClick={() => acc.setConflictsOpen(false)}>Decidir depois</button> <span className="muted">Nada é perdido: o aviso continua visível até você decidir.</span></div>
  </Modal>;
}
