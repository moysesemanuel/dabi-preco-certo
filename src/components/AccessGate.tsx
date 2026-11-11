import { useState, type ReactNode } from 'react';
import { Download, LogOut, WifiOff } from 'lucide-react';
import { useAccount } from '../account/AccountContext';
import { AccountPanel } from '../features/account/AccountPanel';
import type { DataSet } from '../domain/types';
import { downloadBackup } from '../utils';

/**
 * Porta de entrada da versão comercial (VITE_REQUIRE_LOGIN=on): o app só abre com conta e licença ativa.
 * Importante: isto controla o acesso à INTERFACE; os dados deste dispositivo continuam intactos no navegador (nunca são apagados aqui)
 * e o usuário sempre pode exportar um backup. A proteção real do que fica no servidor (sincronização e links) é feita pelo Worker.
 */
export function AccessGate({ data, children }: { data: DataSet; children: ReactNode }) {
  const acc = useAccount();
  const [note, setNote] = useState('');
  if (acc.access === 'open') return <>{children}</>;
  if (acc.access === 'offline-grace') return <>
    <div className="notice warn" role="status" style={{ margin: 0, borderRadius: 0 }}><WifiOff size={15} aria-hidden /> Sem conexão com o servidor. Você pode usar os dados deste dispositivo por um tempo; o acesso será confirmado quando a internet voltar.</div>
    {children}
  </>;

  const hasLocal = data.ingredients.length + data.recipes.length + data.orders.length > 0;
  const exportNow = () => { downloadBackup(data); setNote('Backup exportado. Guarde o arquivo em local seguro.'); };
  return <main className="gate" style={{ maxWidth: 520, margin: '0 auto', padding: '32px 16px' }}>
    <h1 style={{ marginBottom: 4 }}>PedidoCerto</h1>
    {acc.access === 'checking' && <p className="muted" role="status">Verificando seu acesso…</p>}
    {acc.access === 'login' && <>
      <p className="muted">Entre com o e-mail da sua compra para usar o aplicativo.</p>
      <AccountPanel inform={setNote} />
    </>}
    {acc.access === 'inactive' && <section className="card stack">
      <div className="notice warn" role="alert"><strong>Acesso indisponível.</strong> {acc.session?.license ? 'A licença desta conta foi revogada.' : 'Esta conta não tem licença ativa.'} Entre em contato com o suporte.</div>
      <button className="secondary" onClick={() => void acc.signOut()}><LogOut size={16} /> Sair desta conta</button>
    </section>}
    {acc.access !== 'checking' && <section className="card stack" style={{ marginTop: 16 }}>
      <h2 className="section-title">Seus dados atuais</h2>
      <p className="muted">{hasLocal ? 'Este dispositivo já guarda ingredientes, receitas ou encomendas seus. Eles não foram apagados e continuam aqui. Depois de entrar, você escolhe como combiná-los com a conta.' : 'Nenhum dado seu foi apagado.'} Se preferir, baixe uma cópia agora.</p>
      <div><button className="secondary" onClick={exportNow}><Download size={16} /> Baixar backup dos dados deste dispositivo</button></div>
    </section>}
    {note && <div className="notice" role="status" style={{ marginTop: 12 }}>{note}</div>}
  </main>;
}
