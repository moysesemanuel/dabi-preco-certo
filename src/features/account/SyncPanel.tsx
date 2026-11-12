import { RefreshCw } from 'lucide-react';
import { useAccount } from '../../account/AccountContext';
import { isOpenFinancial, isPendingConflict, type ConflictRecord } from '../../sync/engine';
import { conflictName, conflictTitle, KIND_LABEL } from '../../sync/describe';
import { FinancialConflict } from './FinancialConflict';

const KIND_NAME = KIND_LABEL;
const nameOf = (c: ConflictRecord): string => conflictName(c);
const describe = (c: ConflictRecord): string => {
  const what = `${KIND_NAME[c.kind]}${nameOf(c) ? ` “${nameOf(c)}”` : ''}`;
  if (c.resolution?.action === 'keep-local') return `Você manteve a sua alteração em ${what}; a versão da nuvem foi substituída.`;
  if (c.resolution?.action === 'keep-server') return `Você manteve a versão da nuvem de ${what}; sua alteração ficou guardada aqui.`;
  if (c.resolution?.action === 'identical') return `${what}: as duas versões ficaram iguais; nada foi perdido.`;
  if (c.reason === 'edited-elsewhere') return `Sua alteração em ${what} foi substituída por outra, feita em outro dispositivo.`;
  if (c.reason === 'deleted-elsewhere') return `O ${what} foi excluído em outro dispositivo, e sua alteração não foi mantida.`;
  return `O ${what} foi mantido porque algo novo daqui depende dele.`;
};
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function SyncPanel({ inform }: { inform: (m: string) => void }) {
  const acc = useAccount();
  if (acc.status !== 'signed-in') return null;
  const { sync } = acc;
  const label = !acc.entitled ? 'Indisponível (sem licença ativa)' : sync.blocked ? 'Precisa da sua decisão' : ({ idle: 'Aguardando', syncing: 'Sincronizando…', synced: 'Sincronizado', offline: 'Sem conexão (as alterações ficam guardadas e serão enviadas depois)', attention: 'Precisa de atenção', error: 'Não foi possível sincronizar' })[sync.phase];

  return <section className="card stack"><h2 className="section-title">Sincronização</h2>
    <p className="muted">Com a conta, o servidor guarda a versão oficial dos seus dados e este dispositivo mantém uma cópia para uso sem internet. Mudanças feitas offline são enviadas depois.</p>
    <div className={sync.phase === 'synced' ? 'notice' : sync.phase === 'syncing' || sync.phase === 'idle' ? 'notice' : 'notice warn'} role="status"><strong>{label}</strong>{sync.lastSyncedAt ? ` · última vez ${when(sync.lastSyncedAt)}` : ''}{sync.message ? <><br />{sync.message}</> : null}</div>

    {sync.blocked === 'needs-decision' && <div className="notice warn stack" style={{ gap: 10 }}><span>Há dados neste dispositivo e também na sua conta, e eles são diferentes. Nada foi alterado ainda. Combinar une os dois sem apagar nada (itens com o mesmo identificador e conteúdo não se duplicam).</span>
      <div><button className="primary" onClick={() => void acc.chooseMerge()}>Combinar os dados</button></div></div>}
    {sync.blocked === 'account-mismatch' && <div className="notice warn stack" style={{ gap: 10 }}><span>Este dispositivo guarda dados de <strong>outra conta</strong>. Para proteger os dados de cada pessoa, nada será enviado. Você pode sair, ou substituir os dados deste dispositivo pelos da conta atual. <strong>Antes de substituir, exporte um backup</strong> (menu Backup).</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="secondary" onClick={() => void acc.signOut().then(r => { if (!r.ok) inform(r.message); })}>Sair desta conta</button>
        <button className="primary" onClick={() => { if (confirm('Isto apaga os dados guardados NESTE dispositivo e baixa os da conta atual. Já exportou um backup? Esta ação não pode ser desfeita.')) void acc.adoptAccountData().then(() => inform('Dados deste dispositivo substituídos pelos da conta.')); }}>Substituir dados deste dispositivo</button></div></div>}

    {acc.entitled && !sync.blocked && <div><button className="secondary" onClick={() => void acc.syncNow()} disabled={sync.phase === 'syncing'}><RefreshCw size={16} /> Sincronizar agora</button></div>}

    {acc.pendingConflicts.length > 0 && <div className="notice warn stack" style={{ gap: 10 }} aria-label="Conflitos aguardando decisão">
      <strong>Conflitos aguardando decisão ({acc.pendingConflicts.length})</strong>
      <span>{acc.pendingConflicts.map(conflictTitle).join(' · ')}. As duas versões estão preservadas; nada foi sobrescrito.</span>
      <div><button className="primary" onClick={() => acc.setConflictsOpen(true)}>Acessar conflitos</button></div></div>}

    {acc.conflicts.filter(isOpenFinancial).length > 0 && <div className="stack" style={{ gap: 10 }} aria-label="Recebimentos a reconciliar">
      <strong style={{ fontSize: 14 }}>Recebimentos a reconciliar ({acc.conflicts.filter(isOpenFinancial).length})</strong>
      <p className="muted" style={{ margin: 0 }}>Estes valores foram lançados aqui, mas a mesma encomenda foi alterada em outro dispositivo. Nada foi descartado: escolha o que fazer com cada um.</p>
      {acc.conflicts.filter(isOpenFinancial).map(c => <FinancialConflict key={c.id} c={c} inform={inform} />)}
    </div>}

    {acc.conflicts.filter(c => !isPendingConflict(c) && !isOpenFinancial(c)).length > 0 && <div className="stack" style={{ gap: 8 }}><strong style={{ fontSize: 14 }}>Histórico de conflitos ({acc.conflicts.filter(c => !isPendingConflict(c) && !isOpenFinancial(c)).length})</strong>
      <p className="muted" style={{ margin: 0 }}>Versões que foram substituídas ficam guardadas aqui até você dispensar, para refazer a mudança se precisar.</p>
      {acc.conflicts.filter(c => !isPendingConflict(c) && !isOpenFinancial(c)).map(c => <details key={c.id} style={{ border: '1px solid #f0d9b5', borderRadius: 10, padding: '8px 12px', background: '#fffaf2' }}><summary style={{ cursor: 'pointer', fontSize: 14 }}>{describe(c)} <span className="muted">({when(c.at)})</span></summary>
        {c.local ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '8px 0 0' }}>Sua versão: {JSON.stringify(c.local, null, 2)}</pre> : null}</details>)}
      <div><button className="secondary" onClick={() => acc.dismissConflicts()}>Dispensar avisos já tratados</button> {(acc.openFinancial > 0 || acc.pendingConflicts.length > 0) && <span className="muted">Conflitos sem decisão não são dispensados.</span>}</div></div>}
  </section>;
}
