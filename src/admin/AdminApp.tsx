import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, History, KeyRound, LayoutDashboard, LogOut, Mail, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { API_URL, safeApiBase } from '../account/http';
import { AUTH_MESSAGES, createAuthClient, type DeviceInfo, type SessionInfo } from '../account/authClient';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { BrandPanel } from '../components/BrandPanel';
import { ADMIN_MESSAGES, createAdminClient, type AdminClient, type AdminFailure, type AuditEvent, type CustomerDetail, type CustomerRow, type Overview } from './adminClient';
import './admin.css';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ACTIONS: Record<string, string> = { 'customer.create': 'Cadastro de cliente', 'customer.suspend': 'Suspensão de acesso', 'customer.activate': 'Reativação de acesso', 'session.revoke': 'Sessão revogada', 'session.revoke-all': 'Todas as sessões revogadas', 'admin.grant': 'Acesso administrativo concedido', 'admin.revoke': 'Acesso administrativo revogado' };
const RESULTS: Record<string, string> = { ok: 'aplicado', noop: 'sem alteração' };
type View = { name: 'overview' } | { name: 'customers' } | { name: 'customer'; id: string } | { name: 'audit'; licenseId?: string };

/** Painel do proprietário. Toda permissão é decidida pelo servidor; esta tela só mostra o que a API devolve. */
export default function AdminApp({ apiBase }: { apiBase?: string }) {
  const base = apiBase ?? safeApiBase(API_URL);
  const auth = useMemo(() => (base ? createAuthClient(base) : null), [base]);
  const [session, setSession] = useState<SessionInfo | undefined>();
  const [phase, setPhase] = useState<'loading' | 'out' | 'in' | 'network'>('loading');
  const [notice, setNotice] = useState('');
  const csrf = useRef<string | undefined>(undefined);
  csrf.current = session?.csrfToken;
  const api = useMemo(() => (base ? createAdminClient(base, () => csrf.current) : null), [base]);

  const check = useCallback(async () => {
    if (!auth) return;
    const r = await auth.currentSession();
    if (r.ok) { setSession(r.value); setPhase('in'); } else if (r.reason === 'network') setPhase('network'); else { setSession(undefined); setPhase('out'); }
  }, [auth]);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => { document.title = 'Administração — Custô'; const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m); return () => m.remove(); }, []);

  // Estável: se mudasse a cada renderização, as telas refariam as consultas (requisições desnecessárias ao D1).
  const onExpired = useCallback(() => { setSession(undefined); setPhase('out'); setNotice('Sua sessão expirou. Entre novamente.'); }, []);

  async function signOut() {
    if (!auth || !csrf.current) return;
    const r = await auth.logout(csrf.current);
    if (!r.ok) { setNotice(`Você continua conectado: não foi possível confirmar a saída no servidor. ${AUTH_MESSAGES[r.reason]}`); return; }
    setSession(undefined); setPhase('out'); setNotice('');
  }

  if (!base || !auth || !api) return <Shell><section className="card stack"><h1 className="section-title">Administração</h1><div className="notice warn">O serviço online não está configurado nesta versão do aplicativo.</div></section></Shell>;
  if (phase === 'loading') return <Shell><p className="muted" role="status">Verificando sua sessão…</p></Shell>;
  if (phase === 'network') return <Shell><section className="card stack"><div className="notice warn" role="alert">{AUTH_MESSAGES.network}</div><button className="secondary" onClick={() => { setPhase('loading'); void check(); }}>Tentar de novo</button></section></Shell>;
  if (phase === 'out' || !session) return <Shell>{notice && <div className="notice warn" role="alert" style={{ marginBottom: 12 }}>{notice}</div>}<AdminLogin auth={auth} onSession={s => { setSession(s); setPhase('in'); }} /></Shell>;
  return <Console api={api} email={session.user.email} onSignOut={signOut} notice={notice} setNotice={setNotice} onExpired={onExpired} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="auth-page"><div className="auth-shell"><BrandPanel /><main className="auth-content"><div className="auth-content-inner"><h1 className="auth-title">Custô · Administração</h1><p className="muted">Área restrita ao proprietário.</p>{children}</div></main></div></div>;
}

function AdminLogin({ auth, onSession }: { auth: NonNullable<ReturnType<typeof createAuthClient>>; onSession: (s: SessionInfo) => void }) {
  const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [step, setStep] = useState<'email' | 'code' | 'devices'>('email');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [devices, setDevices] = useState<DeviceInfo[]>([]);
  async function ask() { setBusy(true); setError(''); const r = await auth.requestCode(email.trim()); setBusy(false); if (r.ok) setStep('code'); else setError(AUTH_MESSAGES[r.reason]); }
  async function enter(replaceSessionId?: string) {
    setBusy(true); setError('');
    const r = await auth.verifyCode({ email: email.trim(), code: code.trim(), deviceLabel: 'Administração (navegador)', ...(replaceSessionId ? { replaceSessionId } : {}) });
    if (r.ok) { const c = await auth.currentSession(); setBusy(false); if (c.ok) onSession(c.value); else setError(c.reason === 'network' ? AUTH_MESSAGES.network : AUTH_MESSAGES['session-not-kept']); return; }
    setBusy(false);
    if (r.reason === 'device-limit') { setDevices(r.sessions); setStep('devices'); return; }
    setError(AUTH_MESSAGES[r.reason]);
  }
  return <section className="auth-form-panel admin-login"><div className="auth-heading"><h2 className="section-title">{step === 'email' ? 'Entrar' : 'Confirme seu código'}</h2><p>{step === 'email' ? 'Receba um código para acessar o painel do Custô.' : `Confira o e-mail ${email} e digite o código de 8 dígitos.`}</p></div>
    {step === 'email' && <form className="auth-form" onSubmit={e => { e.preventDefault(); void ask(); }}><div className="auth-field"><label htmlFor="admin-email">E-mail do administrador</label><div className="auth-input-wrap"><Mail size={19} aria-hidden="true" /><input id="admin-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="Digite seu e-mail" aria-describedby={error ? 'admin-login-error' : undefined} /></div></div><button className="primary auth-submit" disabled={busy || !email.trim()} aria-busy={busy}>{busy ? 'Enviando…' : 'Enviar código de acesso'}</button></form>}
    {step === 'code' && <form className="auth-form" onSubmit={e => { e.preventDefault(); void enter(); }}><div className="auth-field"><label htmlFor="admin-code">Código de 8 dígitos</label><div className="auth-input-wrap"><KeyRound size={19} aria-hidden="true" /><input id="admin-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{8}" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required placeholder="00000000" aria-describedby={error ? 'admin-login-error' : undefined} /></div></div><button className="primary auth-submit" disabled={busy || code.length !== 8} aria-busy={busy}>{busy ? 'Confirmando…' : 'Confirmar código'}</button><div className="auth-form-links"><button type="button" className="auth-text-action" disabled={busy} onClick={() => void ask()}>Reenviar código</button><button type="button" className="auth-text-action" disabled={busy} onClick={() => { setStep('email'); setError(''); }}><ArrowLeft size={16} aria-hidden="true" /> Corrigir e-mail</button></div></form>}
    {step === 'devices' && <div className="stack"><div className="notice warn">Esta conta já está em 2 dispositivos. Escolha um para desconectar.</div>{devices.map(d => <button key={d.id} type="button" className="secondary" disabled={busy} onClick={() => void enter(d.id)}>Desconectar "{d.deviceLabel ?? 'dispositivo'}" (último uso {when(d.lastSeenAt)})</button>)}<button type="button" className="secondary" onClick={() => setStep('email')}>Cancelar</button></div>}
    {error && <div id="admin-login-error" className="notice error" role="alert">{error}</div>}
    <div className="auth-security"><span className="auth-divider" /><p><ShieldCheck size={16} aria-hidden="true" /> Login seguro, rápido e sem senha.</p></div>
  </section>;
}

function Console({ api, email, onSignOut, notice, setNotice, onExpired }: { api: AdminClient; email: string; onSignOut: () => void; notice: string; setNotice: (m: string) => void; onExpired: () => void }) {
  const [view, setView] = useState<View>({ name: 'overview' });
  const [allowed, setAllowed] = useState<'checking' | 'yes' | 'no' | 'network'>('checking');
  useEffect(() => { let alive = true; void api.me().then(r => { if (!alive) return; if (r.ok) setAllowed('yes'); else if (r.reason === 'unauthorized') onExpired(); else setAllowed(r.reason === 'network' ? 'network' : 'no'); }); return () => { alive = false; }; }, [api, onExpired]);
  // Só a sessão expirada é tratada aqui (volta ao login); as demais falhas aparecem junto da própria ação, sem mensagens duplicadas.
  const fail = useCallback((reason: AdminFailure) => { if (reason === 'unauthorized') onExpired(); }, [onExpired]);
  if (allowed === 'checking') return <Shell><p className="muted" role="status">Verificando permissões…</p></Shell>;
  if (allowed === 'network') return <Shell><div className="notice warn" role="alert">{ADMIN_MESSAGES.network}</div><button className="secondary" onClick={() => location.reload()}>Recarregar</button></Shell>;
  if (allowed === 'no') return <Shell><section className="card stack"><div className="notice warn" role="alert"><strong>Acesso negado.</strong> {ADMIN_MESSAGES.forbidden}</div>{notice && <div className="notice warn" role="status">{notice}</div>}<button className="secondary" onClick={onSignOut}><LogOut size={16} /> Sair desta conta</button></section></Shell>;
  const nav: { id: View['name']; label: string; icon: typeof Users }[] = [{ id: 'overview', label: 'Visão geral', icon: LayoutDashboard }, { id: 'customers', label: 'Clientes', icon: Users }, { id: 'audit', label: 'Histórico', icon: History }];
  const go = (v: View) => { setNotice(''); setView(v); };
  return <div className="app"><a className="skip-link" href="#admin-main">Pular para o conteúdo</a>
    <aside className="sidebar"><div className="brand"><img className="brand-logo" src="/brand/custo-color.svg" alt="Custô" /></div>
      <nav className="nav" aria-label="Navegação administrativa">{nav.map(n => <button key={n.id} className={(view.name === n.id || (n.id === 'customers' && view.name === 'customer')) ? 'active' : ''} aria-current={view.name === n.id ? 'page' : undefined} onClick={() => go({ name: n.id } as View)}><n.icon size={18} />{n.label}</button>)}<button onClick={onSignOut}><LogOut size={18} />Sair</button></nav>
      <div className="sidebar-foot"><span className="admin-nav-note">Conectado como<br /><strong style={{ color: 'var(--color-surface)', overflowWrap: 'anywhere' }}>{email}</strong></span></div></aside>
    <div className="workspace"><div className="topbar"><span>Área administrativa · não exibe dados comerciais dos clientes</span></div>
      <main id="admin-main" className="content" tabIndex={-1}>
        {notice && <div className="notice warn" role="status" style={{ marginBottom: 16 }}>{notice}</div>}
        {view.name === 'overview' && <OverviewPanel api={api} fail={fail} />}
        {view.name === 'customers' && <CustomersPanel api={api} fail={fail} open={id => go({ name: 'customer', id })} inform={setNotice} />}
        {view.name === 'customer' && <CustomerPanel key={view.id} api={api} id={view.id} fail={fail} inform={setNotice} back={() => go({ name: 'customers' })} history={() => go({ name: 'audit', licenseId: view.id })} />}
        {view.name === 'audit' && <AuditPanel api={api} fail={fail} licenseId={view.licenseId} />}
      </main></div></div>;
}

function Head({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, [title]);
  return <div className="head"><div><div className="eyebrow">Administração</div><h1 ref={ref} tabIndex={-1}>{title}</h1>{hint && <p className="muted" style={{ margin: 0 }}>{hint}</p>}</div>{children}</div>;
}

function OverviewPanel({ api, fail }: { api: AdminClient; fail: (r: AdminFailure) => void }) {
  const [o, setO] = useState<Overview | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setBusy(true); const r = await api.overview(); setBusy(false); if (r.ok) { setO(r.value); setErr(''); } else { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); } }, [api, fail]);
  useEffect(() => { void load(); }, [load]);
  const cards: [string, number | undefined, string][] = o ? [
    ['Clientes cadastrados', o.customers.total, 'Licenças com e-mail registradas.'], ['Licença ativa', o.customers.active, 'Podem entrar e sincronizar.'], ['Licença suspensa', o.customers.suspended, 'Sem sincronização nem links.'],
    ['Novos em 30 dias', o.customers.new30d, 'Cadastrados nos últimos 30 dias.'], ['Sessões ativas', o.activeSessions, 'Dispositivos conectados agora (válidos e não revogados).'], ['Com acesso em 7 dias', o.recentUsers7d, 'Contas com algum dispositivo usado na última semana (precisão de cerca de 1 hora).'],
  ] : [];
  return <><Head title="Visão geral" hint="Contagens reais do banco, atualizadas quando você abre ou pede."><button className="secondary" onClick={() => void load()} disabled={busy}>{busy ? 'Atualizando…' : 'Atualizar'}</button></Head>
    {err && <div className="notice error" role="alert">{err}</div>}
    {o && <><div className="admin-metrics">{cards.map(([label, v, hint]) => <div key={label} className="card metric-card"><span className="metric-label">{label}</span><span className="metric">{v}</span><small>{hint}</small></div>)}</div>
      <p className="footnote">Aguardando primeiro login: {o.customers.pendingFirstLogin}. Gerado em {when(o.generatedAt)}. Não há métricas financeiras nem de uso interno: o painel não lê receitas, ingredientes nem encomendas dos clientes.</p></>}
    {!o && !err && <p className="muted" role="status">Carregando…</p>}</>;
}

const statusTag = (s: 'active' | 'revoked') => <span className={s === 'active' ? 'tag green' : 'tag red'}>{s === 'active' ? 'Ativa' : 'Suspensa'}</span>;

function CustomersPanel({ api, fail, open, inform }: { api: AdminClient; fail: (r: AdminFailure) => void; open: (id: string) => void; inform: (m: string) => void }) {
  const [q, setQ] = useState(''); const [applied, setApplied] = useState({ q: '', status: '' }); const [status, setStatus] = useState('');
  const [rows, setRows] = useState<CustomerRow[]>([]); const [next, setNext] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [adding, setAdding] = useState(false); const [loaded, setLoaded] = useState(false);
  const reqId = useRef(0);
  const load = useCallback(async (f: { q: string; status: string }, cursor?: string) => {
    const my = ++reqId.current; setBusy(true);
    const r = await api.customers({ q: f.q || undefined, status: f.status || undefined, cursor });
    if (my !== reqId.current) return; setBusy(false);
    if (!r.ok) { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); return; }
    setErr(''); setLoaded(true); setRows(cur => (cursor ? [...cur, ...r.value.customers] : r.value.customers)); setNext(r.value.nextCursor);
  }, [api, fail]);
  useEffect(() => { void load(applied); }, [applied, load]);
  return <><Head title="Clientes" hint="Pesquise por e-mail ou rótulo. Cada página traz 25 clientes."><button className="primary" onClick={() => setAdding(true)}><UserPlus size={17} /> Cadastrar cliente</button></Head>
    <form className="admin-toolbar" role="search" onSubmit={e => { e.preventDefault(); setApplied({ q: q.trim(), status }); }}>
      <div className="grow"><Field label="Pesquisar"><input type="search" value={q} maxLength={60} placeholder="e-mail ou rótulo" onChange={e => setQ(e.target.value)} /></Field></div>
      <div><Field label="Situação"><select value={status} onChange={e => { setStatus(e.target.value); setApplied({ q: q.trim(), status: e.target.value }); }}><option value="">Todas</option><option value="active">Ativas</option><option value="revoked">Suspensas</option></select></Field></div>
      <button className="secondary" type="submit">Pesquisar</button></form>
    {err && <div className="notice error" role="alert">{err}</div>}
    <ul className="admin-rows" aria-label="Clientes">{rows.map(c => <li key={c.id} className="admin-row"><div className="main"><strong>{c.email}</strong><div className="meta">{statusTag(c.status)}{c.isAdmin && <span className="tag">Administrador</span>}{c.label && <span>{c.label}</span>}<span>Cadastro: {when(c.createdAt)}</span><span>Último acesso: {c.accountId ? when(c.lastAccessAt) : 'ainda não entrou'}</span><span>Sessões ativas: {c.activeSessions}</span></div></div><button className="secondary" onClick={() => open(c.id)} aria-label={`Detalhes de ${c.email}`}>Detalhes</button></li>)}</ul>
    {loaded && !rows.length && !busy && <div className="empty">Nenhum cliente encontrado.</div>}
    {busy && <p className="muted" role="status">Carregando…</p>}
    {next && !busy && <div style={{ marginTop: 14 }}><button className="secondary" onClick={() => void load(applied, next)}>Carregar mais</button></div>}
    {adding && <AddCustomer api={api} close={() => setAdding(false)} done={(msg, id) => { setAdding(false); setApplied({ q: '', status: '' }); setQ(''); setStatus(''); if (id) open(id); inform(msg); }} fail={fail} />}</>;
}

function AddCustomer({ api, close, done, fail }: { api: AdminClient; close: () => void; done: (msg: string, id: string | null) => void; fail: (r: AdminFailure) => void }) {
  const [email, setEmail] = useState(''); const [label, setLabel] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await api.createCustomer({ email: email.trim(), ...(label.trim() ? { label: label.trim() } : {}) }); setBusy(false);
    if (!r.ok) { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); return; }
    done(r.value.created ? `Cliente cadastrado: ${r.value.email}. Nenhum e-mail foi enviado; o primeiro login usa o código por e-mail.` : `Já existe uma licença para ${r.value.email}; nada foi criado nem alterado.`, r.value.id);
  }
  return <Modal title="Cadastrar cliente" titleId="add-customer" onClose={close} closeLabel="Fechar"><form className="stack" onSubmit={submit}>
    <Field label="E-mail do cliente"><input type="email" data-autofocus value={email} onChange={e => setEmail(e.target.value)} required /></Field>
    <Field label="Rótulo (opcional, só para você)"><input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} placeholder="ex.: Doces da Bia" /></Field>
    <p className="muted" style={{ margin: 0 }}>Cria a licença ativa para este e-mail. Nenhum código é enviado agora; o cliente pede o código na tela de login.</p>
    {err && <div className="notice error" role="alert">{err}</div>}
    <div className="modal-actions"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !email.trim()}>{busy ? 'Cadastrando…' : 'Cadastrar'}</button></div></form></Modal>;
}

type Pending = { kind: 'suspend' | 'revoke-all' | 'revoke-one' | 'activate'; sessionId?: string; label?: string };

function CustomerPanel({ api, id, fail, inform, back, history }: { api: AdminClient; id: string; fail: (r: AdminFailure) => void; inform: (m: string) => void; back: () => void; history: () => void }) {
  const [d, setD] = useState<CustomerDetail | null>(null); const [err, setErr] = useState(''); const [pending, setPending] = useState<Pending | null>(null);
  const load = useCallback(async () => { const r = await api.customer(id); if (r.ok) { setD(r.value); setErr(''); } else { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); } }, [api, id, fail]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <><Head title="Cliente" /><button className="secondary" onClick={back}>Voltar à lista</button>{err ? <div className="notice error" role="alert" style={{ marginTop: 12 }}>{err}</div> : <p className="muted" role="status">Carregando…</p>}</>;
  const c = d.customer;
  return <><Head title={c.email} hint="Dados administrativos da conta."><button className="secondary" onClick={back}>Voltar à lista</button></Head>
    {err && <div className="notice error" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
    <section className="card stack" style={{ marginBottom: 16 }}><h2 className="section-title">Conta</h2>
      <dl className="admin-dl"><dt>Licença</dt><dd>{statusTag(c.status)}{c.suspendedAt && ` desde ${when(c.suspendedAt)}`}</dd><dt>Identificador da conta</dt><dd>{c.accountId ?? 'ainda não entrou (sem conta criada)'}</dd><dt>Licença (ID)</dt><dd>{c.id}</dd><dt>E-mail</dt><dd>{c.email}</dd>{c.label && <><dt>Rótulo</dt><dd>{c.label}</dd></>}
        <dt>Cadastro</dt><dd>{when(c.createdAt)}</dd><dt>Primeiro acesso</dt><dd>{when(c.emailVerifiedAt)}</dd><dt>Último acesso</dt><dd>{c.accountId ? when(c.lastAccessAt) : '—'}</dd><dt>Limites</dt><dd>{c.quotaActive} links ativos · {c.quotaDaily} novos por dia</dd></dl>
      {c.isAdmin ? <div className="notice warn">Conta administrativa: não pode ser suspensa nem desconectada por este painel.</div> : <div className="admin-actions">{c.status === 'active' ? <button className="secondary danger" onClick={() => setPending({ kind: 'suspend' })}>Suspender acesso</button> : <button className="primary" onClick={() => setPending({ kind: 'activate' })}>Reativar acesso</button>}</div>}</section>
    <section className="card stack" style={{ marginBottom: 16 }}><h2 className="section-title">Sessões ativas ({d.sessions.length})</h2>
      {!d.sessions.length ? <p className="muted">Nenhum dispositivo conectado.</p> : <ul className="admin-rows">{d.sessions.map(s => <li key={s.id} className="admin-row"><div className="main"><strong>{s.deviceLabel ?? 'Dispositivo'}</strong><div className="meta"><span>Último uso: {when(s.lastSeenAt)}</span><span>Entrou em: {when(s.createdAt)}</span><span>Expira: {when(s.expiresAt)}</span></div></div>{!c.isAdmin && <button className="secondary danger" onClick={() => setPending({ kind: 'revoke-one', sessionId: s.id, label: s.deviceLabel ?? 'dispositivo' })}>Revogar</button>}</li>)}</ul>}
      {!c.isAdmin && d.sessions.length > 0 && <div className="admin-actions"><button className="secondary danger" onClick={() => setPending({ kind: 'revoke-all' })}>Revogar todas as sessões</button></div>}</section>
    <section className="card stack"><h2 className="section-title">Histórico administrativo</h2>
      {!d.history.length ? <p className="muted">Nenhuma ação administrativa registrada para esta conta.</p> : <AuditList events={d.history} />}
      {d.historyHasMore && <div><button className="secondary" onClick={history}>Ver histórico completo</button></div>}</section>
    {pending && <Confirm pending={pending} email={c.email} api={api} id={id} close={() => setPending(null)} done={async msg => { setPending(null); inform(msg); await load(); }} fail={fail} />}</>;
}

function Confirm({ pending, email, api, id, close, done, fail }: { pending: Pending; email: string; api: AdminClient; id: string; close: () => void; done: (msg: string) => Promise<void>; fail: (r: AdminFailure) => void }) {
  const needsTyping = pending.kind === 'suspend' || pending.kind === 'revoke-all';
  const [typed, setTyped] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const text = { suspend: ['Suspender acesso', 'O cliente continua conectado, mas não sincroniza nem publica links. Nenhum dado é apagado. Você pode reativar depois.', 'Suspender'], activate: ['Reativar acesso', 'O cliente volta a sincronizar e publicar links.', 'Reativar'], 'revoke-all': ['Revogar todas as sessões', 'Todos os dispositivos do cliente serão desconectados e precisarão de um novo código por e-mail.', 'Revogar todas'], 'revoke-one': [`Revogar sessão de "${pending.label}"`, 'Este dispositivo será desconectado e precisará de um novo código.', 'Revogar'] }[pending.kind];
  async function run() {
    setBusy(true); setErr('');
    const r = pending.kind === 'suspend' ? await api.suspend(id, typed.trim()) : pending.kind === 'activate' ? await api.activate(id) : pending.kind === 'revoke-all' ? await api.revokeAll(id, typed.trim()) : await api.revokeSession(id, pending.sessionId as string);
    setBusy(false);
    if (!r.ok) { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); return; }   // só confirma o que o servidor confirmou
    const v = r.value as { changed?: boolean; revoked?: number | string };
    await done(pending.kind === 'suspend' ? (v.changed === false ? 'Acesso já estava suspenso.' : 'Acesso suspenso.') : pending.kind === 'activate' ? (v.changed === false ? 'Acesso já estava ativo.' : 'Acesso reativado.') : pending.kind === 'revoke-all' ? `Sessões revogadas: ${v.revoked}.` : 'Sessão revogada.');
  }
  return <Modal title={text[0]} titleId="confirm-admin" onClose={close} closeLabel="Fechar"><div className="stack">
    <p style={{ margin: 0 }}>{text[1]}</p>
    {needsTyping && <Field label={`Para confirmar, digite o e-mail do cliente (${email})`}><input data-autofocus value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></Field>}
    {err && <div className="notice error" role="alert">{err}</div>}
    <div className="modal-actions"><button className="secondary" onClick={close}>Cancelar</button><button className={pending.kind === 'activate' ? 'primary' : 'primary'} disabled={busy || (needsTyping && typed.trim().toLowerCase() !== email)} onClick={() => void run()}>{busy ? 'Aguarde…' : text[2]}</button></div></div></Modal>;
}

function AuditList({ events }: { events: AuditEvent[] }) {
  return <ul className="admin-rows" aria-label="Eventos administrativos">{events.map(e => <li key={e.id} className="admin-row"><div className="main"><strong>{ACTIONS[e.action] ?? e.action}</strong><div className="meta"><span>{when(e.at)}</span><span>Por: {e.admin ?? 'administrador removido'}</span>{e.customerEmail && <span>Conta: {e.customerEmail}</span>}<span>Resultado: {RESULTS[e.result] ?? e.result}{e.detail ? ` (${e.detail})` : ''}</span></div></div></li>)}</ul>;
}

function AuditPanel({ api, fail, licenseId }: { api: AdminClient; fail: (r: AdminFailure) => void; licenseId?: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]); const [next, setNext] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [loaded, setLoaded] = useState(false);
  const load = useCallback(async (cursor?: string) => { setBusy(true); const r = await api.audit({ licenseId, cursor }); setBusy(false); if (!r.ok) { setErr(ADMIN_MESSAGES[r.reason]); fail(r.reason); return; } setErr(''); setLoaded(true); setEvents(cur => (cursor ? [...cur, ...r.value.events] : r.value.events)); setNext(r.value.nextCursor); }, [api, fail, licenseId]);
  useEffect(() => { void load(); }, [load]);
  return <><Head title="Histórico" hint={licenseId ? 'Ações administrativas desta conta.' : 'Ações administrativas, mais recentes primeiro. Eventos com mais de 1 ano são removidos.'} />
    {err && <div className="notice error" role="alert">{err}</div>}
    <AuditList events={events} />{loaded && !events.length && <div className="empty">Nenhum evento registrado.</div>}
    {busy && <p className="muted" role="status">Carregando…</p>}{next && !busy && <div style={{ marginTop: 14 }}><button className="secondary" onClick={() => void load(next)}>Carregar mais</button></div>}</>;
}
