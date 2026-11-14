import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AccountPanel } from '../features/account/AccountPanel';
import { SyncPanel } from '../features/account/SyncPanel';
import { PublishedLinks } from '../features/sharing/PublishedLinks';
import { Field } from '../components/Field';
import { normalizePhone } from '../../shared/publicQuote';
import { WEEKDAY_NAMES, DEFAULT_WORK_WEEKDAYS } from '../domain/schedule';
import { withSettings, type PageProps } from '../utils';


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
  return <>
    <div className="head"><div><div className="eyebrow">Seu negócio e sua conta</div><h1>Configurações</h1><p className="muted">Dados do negócio e capacidade funcionam sem conta. A conta (opcional) libera a sincronização entre dispositivos e o compartilhamento de orçamentos por link.</p></div></div>
    <div className="stack">
      {/* `key`: se as configurações mudarem por fora (ex.: vieram da sincronização), o formulário recarrega em vez de mostrar valores velhos */}
      <BusinessSettings key={JSON.stringify(props.data.settings ?? {})} {...props} />
      <div className="two"><AccountPanel inform={inform} /><SyncPanel inform={inform} /></div>
      <PublishedLinks inform={inform} />
    </div>
  </>;
}
