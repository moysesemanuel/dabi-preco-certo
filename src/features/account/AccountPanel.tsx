import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LogIn, LogOut, MonitorSmartphone, Trash2 } from 'lucide-react';
import { useAccount } from '../../account/AccountContext';
import { AUTH_MESSAGES, type DeviceInfo } from '../../account/authClient';
import { Field } from '../../components/Field';

const defaultDeviceLabel = (): string => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo';
  return `${os} (navegador)`;
};
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function AccountPanel({ inform }: { inform: (m: string) => void }) {
  const acc = useAccount();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [step, setStep] = useState<'email' | 'code' | 'devices'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limitDevices, setLimitDevices] = useState<DeviceInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);

  const loadDevices = useCallback(async () => { if (!acc.auth) return; const r = await acc.auth.listSessions(); if (r.ok) setDevices(r.value); }, [acc.auth]);
  useEffect(() => { if (acc.status === 'signed-in') void loadDevices(); }, [acc.status, loadDevices]);

  if (acc.status === 'unconfigured') return <section className="card stack"><h2 className="section-title">Conta</h2><div className="notice warn">O serviço online não está configurado nesta versão do aplicativo. Tudo continua funcionando neste dispositivo, sem conta.</div></section>;
  if (acc.status === 'loading') return <section className="card stack"><h2 className="section-title">Conta</h2><p className="muted" role="status">Verificando sua conta…</p></section>;

  async function ask(e: FormEvent) {
    e.preventDefault(); if (!acc.auth) return;
    setBusy(true); setError('');
    const r = await acc.auth.requestCode(email.trim());
    setBusy(false);
    if (r.ok) { setStep('code'); setCode(''); inform('Se houver uma licença para este e-mail, enviamos um código de acesso.'); }
    else setError(AUTH_MESSAGES[r.reason] + (r.reason === 'rate-limited' && r.retryAfter ? ` (cerca de ${Math.ceil(r.retryAfter / 60)} min)` : ''));
  }
  async function enter(e: FormEvent, replaceSessionId?: string) {
    e.preventDefault(); if (!acc.auth) return;
    setBusy(true); setError('');
    const r = await acc.auth.verifyCode({ email: email.trim(), code: code.trim(), deviceLabel: label.trim() || undefined, ...(replaceSessionId ? { replaceSessionId } : {}) });
    setBusy(false);
    if (r.ok) {
      // Só vale como "entrou" se o navegador realmente guardou a sessão: confirma lendo a sessão atual (cookie) ANTES de avisar o sucesso.
      const check = await acc.auth.currentSession();
      if (!check.ok) { setError(check.reason === 'network' ? AUTH_MESSAGES.network : AUTH_MESSAGES['session-not-kept']); return; }
      acc.setSession(check.value); setStep('email'); setCode(''); inform('Você entrou na sua conta.'); return;
    }
    if (r.reason === 'device-limit') { setLimitDevices(r.sessions); setStep('devices'); return; }
    setError(AUTH_MESSAGES[r.reason]);
  }
  async function removeDevice(d: DeviceInfo) {
    if (!acc.auth || !acc.session) return;
    if (!confirm(d.current ? 'Sair deste dispositivo?' : `Desconectar "${d.deviceLabel ?? 'dispositivo'}"? Ele precisará entrar de novo.`)) return;
    const r = await acc.auth.revokeSession(acc.session.csrfToken, d.id);
    if (!r.ok) return inform(AUTH_MESSAGES[r.reason]);
    if (d.current) { acc.setSession(undefined); inform('Você saiu desta conta.'); } else { inform('Dispositivo desconectado.'); void loadDevices(); }
  }

  if (acc.status === 'signed-in' && acc.session) {
    const s = acc.session;
    return <section className="card stack"><span className="icon-box"><MonitorSmartphone size={21} /></span><h2 className="section-title">Conta</h2>
      <div className="notice">Conectado como <strong>{s.user.email}</strong>.</div>
      {s.license?.status === 'active' ? <p className="muted">Licença ativa. Limites: {s.license.quotaActive} links ativos e {s.license.quotaDaily} novos links por dia.</p> : <div className="notice warn">{s.license ? 'A licença desta conta foi revogada.' : 'Esta conta não tem licença ativa.'} A sincronização e o compartilhamento ficam indisponíveis, mas seus dados continuam neste dispositivo.</div>}
      <div><strong style={{ fontSize: 14 }}>Dispositivos autorizados (máx. 2)</strong>
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>{devices.map(d => <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f0f2f4' }}>
          <span>{d.deviceLabel ?? 'Dispositivo'}{d.current ? <span className="tag green" style={{ marginLeft: 6 }}>Este aparelho</span> : null}<span className="muted" style={{ display: 'block', fontSize: 12 }}>Último uso: {when(d.lastSeenAt)}</span></span>
          <button className="inline-icon" aria-label={d.current ? 'Sair deste dispositivo' : `Desconectar ${d.deviceLabel ?? 'dispositivo'}`} title={d.current ? 'Sair' : 'Desconectar'} onClick={() => void removeDevice(d)}><Trash2 size={15} /></button></li>)}</ul></div>
      <button className="secondary" type="button" onClick={() => void acc.signOut().then(() => inform('Você saiu desta conta. Seus dados continuam neste dispositivo.'))}><LogOut size={16} /> Sair desta conta</button>
    </section>;
  }

  return <section className="card stack"><span className="icon-box"><LogIn size={21} /></span><h2 className="section-title">Entrar na conta</h2>
    <p className="muted">{acc.requireLogin ? 'O acesso é liberado pela sua licença. A conta permite usar seus dados em até 2 dispositivos e compartilhar orçamentos por link.' : 'A conta é opcional e liberada pela sua licença. Ela permite usar seus dados em até 2 dispositivos e compartilhar orçamentos por link. Sem conta, tudo funciona neste dispositivo.'}</p>
    {step === 'email' && <form className="stack" onSubmit={ask}>
      <Field label="E-mail da compra"><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="voce@exemplo.com" /></Field>
      <button className="primary" type="submit" disabled={busy || !email.trim()}>{busy ? 'Enviando…' : 'Enviar código de acesso'}</button>
      {email.trim() && <button type="button" className="secondary" onClick={() => setStep('code')}>Já tenho um código</button>}
    </form>}
    {step === 'code' && <form className="stack" onSubmit={e => void enter(e)}>
      <p className="muted" style={{ margin: 0 }}>Código enviado para <strong>{email}</strong>, se houver licença. Vale por 10 minutos e só pode ser usado uma vez.</p>
      <Field label="Código de 8 dígitos"><input inputMode="numeric" autoComplete="one-time-code" pattern="\d{8}" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required placeholder="00000000" /></Field>
      <Field label="Nome deste dispositivo"><input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} /></Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="primary" type="submit" disabled={busy || code.length !== 8}>{busy ? 'Entrando…' : 'Entrar'}</button><button type="button" className="secondary" onClick={() => { setStep('email'); setError(''); }}>Voltar</button></div>
    </form>}
    {step === 'devices' && <div className="stack">
      <div className="notice warn">Esta conta já está em 2 dispositivos. Escolha um para desconectar e entrar neste.</div>
      {limitDevices.map(d => <button key={d.id} type="button" className="secondary" disabled={busy} onClick={e => void enter(e as unknown as FormEvent, d.id)}>Desconectar "{d.deviceLabel ?? 'dispositivo'}" (último uso {when(d.lastSeenAt)})</button>)}
      <button type="button" className="secondary" onClick={() => { setStep('email'); setError(''); }}>Cancelar</button>
    </div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {!error && acc.authNotice && <div className="notice warn" role="alert">{acc.authNotice}</div>}
  </section>;
}
