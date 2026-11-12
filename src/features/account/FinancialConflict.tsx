import { useAccount } from '../../account/AccountContext';
import type { ConflictRecord } from '../../sync/engine';
import { describeFinancial } from '../../sync/reconcile';
import { conflictName } from '../../sync/describe';

/** Reconciliação explícita de recebimentos (uma encomenda). Usada na tela de conflitos e em Configurações. */
export function FinancialConflict({ c, inform }: { c: ConflictRecord; inform: (m: string) => void }) {
  const acc = useAccount();
  return <div className="notice warn stack" style={{ gap: 8 }}>
    <strong>Encomenda de “{conflictName(c)}”{c.reason === 'deleted-elsewhere' ? ' (excluída em outro dispositivo)' : ''}</strong>
    <ul style={{ margin: 0, paddingLeft: 18 }}>{describeFinancial(c).map((l, i) => <li key={i}>{l}</li>)}</ul>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="primary" onClick={() => { try { acc.resolveFinancial(c.id, 'merge'); inform(c.reason === 'deleted-elsewhere' ? 'Encomenda recuperada com os recebimentos.' : 'Recebimentos somados à encomenda.'); } catch (e) { inform(e instanceof Error ? e.message : 'Não foi possível reconciliar.'); } }}>{c.reason === 'deleted-elsewhere' ? 'Recuperar encomenda e recebimentos' : 'Somar os meus recebimentos'}</button>
      <button className="secondary" onClick={() => { if (confirm(`Manter só o que o servidor tem?\n\nOs valores abaixo NÃO serão aplicados:\n${describeFinancial(c).join('\n')}`)) { acc.resolveFinancial(c.id, 'keep-server'); inform('Mantida a versão do servidor.'); } }}>Manter a versão do servidor</button>
    </div></div>;
}
