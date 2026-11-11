import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { licenseStorage, maskLicenseKey, safeApiBase, verifyLicense, type LicenseCheck } from '../features/sharing/licenseClient';
import { Field } from '../components/Field';
import { normalizePhone } from '../../shared/publicQuote';
import { WEEKDAY_NAMES, DEFAULT_WORK_WEEKDAYS } from '../domain/schedule';
import { withSettings, type PageProps } from '../utils';

const API_URL = import.meta.env.VITE_QUOTES_API_URL as string | undefined;

function statusView(check: LicenseCheck | null): { className: string; text: string } | null {
  if (!check) return null;
  switch (check.state) {
    case 'valid': return { className: 'notice', text: `Licença válida. Orçamentos ativos: ${check.quotas.active.used} de ${check.quotas.active.limit}. Criados hoje: ${check.quotas.daily.used} de ${check.quotas.daily.limit}.` };
    case 'invalid': return { className: 'notice error', text: 'Licença inválida: a chave não foi reconhecida. Confira se copiou a chave completa.' };
    case 'revoked': return { className: 'notice warn', text: 'Licença revogada. Entre em contato com o suporte para regularizar.' };
    case 'rate-limited': return { className: 'notice warn', text: `Muitas verificações. Tente novamente em ${check.retryAfterSeconds ?? 60} segundos.` };
    case 'error': return { className: 'notice warn', text: ({ 'not-configured': 'O serviço de compartilhamento ainda não está configurado nesta versão do aplicativo.', 'bad-format': 'Formato de chave inválido. A chave começa com "dabi_lic_" e tem 41 caracteres.', network: 'Não foi possível falar com o serviço. Verifique sua conexão e tente de novo.', unexpected: 'Resposta inesperada do serviço. Tente novamente mais tarde.' })[check.reason] };
  }
}

function BusinessSettings({ data, update, inform }: PageProps) {
  const s = data.settings;
  const [name, setName] = useState(s?.businessName ?? '');
  const [phone, setPhone] = useState(s?.businessPhone ?? '');
  const [capacity, setCapacity] = useState(s?.dailyCapacityMinutes !== undefined ? String(s.dailyCapacityMinutes) : '');
  const [days, setDays] = useState<number[]>(s?.workWeekdays ?? DEFAULT_WORK_WEEKDAYS);
  function save(e: FormEvent) {
    e.preventDefault();
    const normalizedPhone = phone.trim() ? normalizePhone(phone) : '';
    if (phone.trim() && !normalizedPhone) return inform('Telefone inválido. Use DDD e número, ex.: (41) 99999-0000.');
    if (name.trim().length > 80) return inform('O nome do negócio pode ter até 80 caracteres.');
    const cap = capacity.trim() === '' ? undefined : Number(capacity.replace(',', '.'));
    if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0 && cap <= 1440)) return inform('A capacidade diária deve ser um número inteiro de minutos (0 a 1440).');
    if (!days.length) return inform('Escolha ao menos um dia de trabalho.');
    update(d => { const base = withSettings(d, {}); const { businessName, businessPhone, dailyCapacityMinutes, ...rest } = base.settings!; void businessName; void businessPhone; void dailyCapacityMinutes;
      return { ...base, settings: { ...rest, ...(name.trim() ? { businessName: name.trim() } : {}), ...(normalizedPhone ? { businessPhone: normalizedPhone } : {}), ...(cap !== undefined ? { dailyCapacityMinutes: cap } : {}), workWeekdays: [...days].sort((a, b) => a - b) } }; });
    inform('Configurações do negócio salvas.');
  }
  return <section className="card stack"><h2 className="section-title">Negócio e capacidade</h2>
    <form className="stack" onSubmit={save}>
      <Field label="Nome do negócio (aparece nos orçamentos)"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Ex.: Doces da Bia" /></Field>
      <Field label="Telefone/WhatsApp do negócio (aparece nos orçamentos)"><input inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(41) 99999-0000" /></Field>
      <Field label="Capacidade de produção por dia (minutos)"><input type="number" min="0" max="1440" step="1" value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="Ex.: 240 (4 horas)" /></Field>
      <div><label>Dias de trabalho</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{WEEKDAY_NAMES.map((n, i) => <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500, margin: 0, fontSize: 13 }}><input type="checkbox" style={{ width: 16, height: 16 }} checked={days.includes(i)} onChange={e => setDays(list => (e.target.checked ? [...list, i] : list.filter(x => x !== i)))} /> {n.slice(0, 3)}</label>)}</div></div>
      <p className="form-subtitle" style={{ margin: 0 }}>O telefone fica visível para quem abrir o link de um orçamento. A capacidade é usada só para estimar prazos (não garante entrega).</p>
      <button className="primary" type="submit"><ShieldCheck size={17} /> Salvar</button>
    </form></section>;
}

export function SettingsPage(props: PageProps) {
  const { inform } = props;
  const [saved, setSaved] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [check, setCheck] = useState<LicenseCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = safeApiBase(API_URL) !== undefined;
  useEffect(() => { setSaved(licenseStorage.get()); }, []);

  async function activate() {
    const key = (input || saved || '').trim();
    setBusy(true);
    const result = await verifyLicense(API_URL, key);
    setBusy(false);
    setCheck(result);
    if (result.state === 'valid' && input.trim()) {
      if (licenseStorage.set(key)) { setSaved(key); setInput(''); inform('Licença verificada e salva neste dispositivo.'); }
      else inform('Licença válida, mas não foi possível salvá-la neste navegador.');
    }
  }
  function remove() {
    if (!confirm('Remover a chave de licença deste dispositivo? Você poderá informá-la novamente depois.')) return;
    licenseStorage.clear(); setSaved(null); setInput(''); setCheck(null);
    inform('Chave removida deste dispositivo.');
  }
  const view = statusView(check);

  return <>
    <div className="head"><div><div className="eyebrow">Compartilhamento de orçamentos</div><h1>Configurações</h1><p className="muted">A licença é necessária somente para compartilhar orçamentos por link. Precificação, receitas e encomendas funcionam sem licença e sem internet.</p></div></div>
    <div style={{ marginBottom: 19 }}><BusinessSettings {...props} /></div>
    <div className="two">
      <section className="card stack"><span className="icon-box"><KeyRound size={21} /></span><h2 className="section-title">Chave de licença</h2>
        {saved && <div className="notice">Chave salva neste dispositivo: <strong>{maskLicenseKey(saved)}</strong></div>}
        <form className="stack" onSubmit={e => { e.preventDefault(); void activate(); }}>
          <Field label={saved ? 'Substituir por outra chave (opcional)' : 'Chave recebida na compra'}><input type="password" autoComplete="off" spellCheck={false} value={input} onChange={e => setInput(e.target.value)} placeholder="dabi_lic_…" aria-label="Chave de licença" /></Field>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" type="submit" disabled={busy || !configured || (!input.trim() && !saved)}><ShieldCheck size={17} /> {busy ? 'Verificando…' : saved && !input.trim() ? 'Verificar licença' : 'Ativar e verificar'}</button>
            {saved && <button className="secondary" type="button" onClick={remove}><Trash2 size={16} /> Remover chave deste dispositivo</button>}
          </div>
        </form>
        {!configured && <div className="notice warn">O serviço de compartilhamento ainda não está configurado nesta versão do aplicativo.</div>}
        {view && <div className={view.className} role="status">{view.text}</div>}
      </section>
      <section className="card stack"><h2 className="section-title">Como a chave é tratada</h2>
        <p className="muted">A chave fica salva apenas neste navegador, separada dos seus dados. Ela <strong>não entra nos backups</strong> e só é enviada ao serviço de compartilhamento, em um cabeçalho seguro, nunca no endereço da página.</p>
        <p className="muted">O armazenamento do navegador <strong>não protege</strong> contra quem tem acesso a este dispositivo ou perfil, nem contra programas maliciosos. Em computadores compartilhados, remova a chave ao terminar.</p>
        <p className="muted">Se a chave vazar, peça ao suporte para revogá-la e emitir outra.</p>
      </section>
    </div>
  </>;
}
