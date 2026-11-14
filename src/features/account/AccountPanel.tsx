import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, LogOut, Mail, MonitorSmartphone, ShieldCheck, Trash2 } from 'lucide-react';
import { useAccount } from '../../account/AccountContext';
import { AUTH_MESSAGES, type DeviceInfo } from '../../account/authClient';
import { Field } from '../../components/Field';

const defaultDeviceLabel = (): string => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Dispositivo';
  return `${os} (navegador)`;
};
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function AccountPanel({ inform, variant = 'settings' }: { inform: (m: string) => void; variant?: 'settings' | 'gate' }) {
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

  if (acc.status === 'unconfigured') return <section className={variant === 'gate' ? 'auth-form-panel' : 'card stack'}><h2 className="section-title">Conta</h2><div className="notice warn">O serviço online não está configurado nesta versão do aplicativo. Tudo continua funcionando neste dispositivo, sem conta.</div></section>;
  if (acc.status === 'loading') return <section className={variant === 'gate' ? 'auth-form-panel' : 'card stack'}><h2 className="section-title">Conta</h2><p className="muted" role="status">Verificando sua conta…</p></section>;

  async function requestCode() {
    if (!acc.auth) return;
    setBusy(true); setError('');
    const r = await acc.auth.requestCode(email.trim());
    setBusy(false);
    if (r.ok) { setStep('code'); setCode(''); inform('Se houver uma licença para este e-mail, enviamos um código de acesso.'); }
    else setError(AUTH_MESSAGES[r.reason] + (r.reason === 'rate-limited' && r.retryAfter ? ` (cerca de ${Math.ceil(r.retryAfter / 60)} min)` : ''));
  }
  async function enter(replaceSessionId?: string) {
    if (!acc.auth) return;
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
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>{devices.map(d => <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
          <span>{d.deviceLabel ?? 'Dispositivo'}{d.current ? <span className="tag green" style={{ marginLeft: 6 }}>Este aparelho</span> : null}<span className="muted" style={{ display: 'block', fontSize: 12 }}>Último uso: {when(d.lastSeenAt)}</span></span>
          <button className="inline-icon" aria-label={d.current ? 'Sair deste dispositivo' : `Desconectar ${d.deviceLabel ?? 'dispositivo'}`} title={d.current ? 'Sair' : 'Desconectar'} onClick={() => void removeDevice(d)}><Trash2 size={15} /></button></li>)}</ul></div>
      <button className="secondary" type="button" onClick={() => void acc.signOut().then(r => inform(r.ok ? 'Você saiu desta conta. Seus dados continuam neste dispositivo.' : r.message))}><LogOut size={16} /> Sair desta conta</button>
    </section>;
  }

  const gate = variant === 'gate';
  return <section className={gate ? 'auth-form-panel' : 'card stack account-login'}>
    <div className="auth-heading">
      {step === 'email' ? <>{gate ? <h1 className="auth-title">Acesse sua conta</h1> : <h2 className="section-title">Entrar na conta</h2>}<p>{gate ? 'Receba um código por e-mail e entre no Custô.' : acc.requireLogin ? 'O acesso é liberado pela sua licença. A conta permite usar seus dados em até 2 dispositivos e compartilhar orçamentos por link.' : 'A conta é opcional e liberada pela sua licença. Ela permite usar seus dados em até 2 dispositivos e compartilhar orçamentos por link. Sem conta, tudo funciona neste dispositivo.'}</p></>
        : <>{gate ? <h1 className="auth-title">Confirme seu código</h1> : <h2 className="section-title">Entrar na conta</h2>}<p>{gate ? <>Confira o e-mail <strong>{email}</strong> e digite o código de 8 dígitos.</> : <>Código enviado para <strong>{email}</strong>, se houver licença. Vale por 10 minutos e só pode ser usado uma vez.</>}</p></>}
    </div>
    {step === 'email' && <form className="auth-form" onSubmit={e => { e.preventDefault(); void requestCode(); }}>
      <div className="auth-field"><label htmlFor="account-email">{gate ? 'Seu e-mail' : 'E-mail da compra'}</label><div className="auth-input-wrap"><Mail size={19} aria-hidden="true" /><input id="account-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder={gate ? 'Digite seu e-mail' : 'voce@exemplo.com'} aria-describedby={error ? 'account-error' : undefined} /></div></div>
      <button className="primary auth-submit" type="submit" disabled={busy || !email.trim()} aria-busy={busy}>{busy ? 'Enviando…' : gate ? 'Enviar código' : 'Enviar código de acesso'}</button>
      {email.trim() && <button type="button" className="auth-text-action" disabled={busy} onClick={() => { setStep('code'); setError(''); }}>Já tenho um código</button>}
    </form>}
    {step === 'code' && <form className="auth-form" onSubmit={e => { e.preventDefault(); void enter(); }}>
      <p className="auth-code-note">Se houver uma licença para este e-mail, o código enviado vale por 10 minutos e só pode ser usado uma vez.</p>
      <div className="auth-field"><label htmlFor="account-code">Código de 8 dígitos</label><div className="auth-input-wrap"><KeyRound size={19} aria-hidden="true" /><input id="account-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{8}" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required placeholder="00000000" aria-describedby={error ? 'account-error' : undefined} /></div></div>
      <Field label="Nome deste dispositivo"><input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} /></Field>
      <button className="primary auth-submit" type="submit" disabled={busy || code.length !== 8} aria-busy={busy}>{busy ? (gate ? 'Confirmando…' : 'Entrando…') : gate ? 'Confirmar código' : 'Entrar'}</button>
      <div className="auth-form-links"><button type="button" className="auth-text-action" disabled={busy} onClick={() => void requestCode()}>Reenviar código</button><button type="button" className="auth-text-action" disabled={busy} onClick={() => { setStep('email'); setError(''); }}><ArrowLeft size={16} aria-hidden="true" /> Corrigir e-mail</button></div>
    </form>}
    {step === 'devices' && <div className="stack">
      <div className="notice warn">Esta conta já está em 2 dispositivos. Escolha um para desconectar e entrar neste.</div>
      {limitDevices.map(d => <button key={d.id} type="button" className="secondary" disabled={busy} onClick={() => void enter(d.id)}>Desconectar "{d.deviceLabel ?? 'dispositivo'}" (último uso {when(d.lastSeenAt)})</button>)}
      <button type="button" className="secondary" onClick={() => { setStep('email'); setError(''); }}>Cancelar</button>
    </div>}
    {error && <div id="account-error" className="notice error" role="alert">{error}</div>}
    {!error && acc.authNotice && <div className="notice warn" role="alert">{acc.authNotice}</div>}
    <div className="auth-security"><span className="auth-divider" /><p><ShieldCheck size={16} aria-hidden="true" /> Login seguro, rápido e sem senha.</p></div>
  </section>;
}
