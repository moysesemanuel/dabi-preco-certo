import type { Measured } from './profile';

/**
 * Limites do plano gratuito (verificados nas documentações oficiais em 12/11/2026; veja docs/POLITICA_DE_CUSTOS.md).
 * Mudou algo na documentação? Atualize aqui E na política.
 */
export const FREE_LIMITS = {
  workerRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytesPerDatabase: 500 * 1024 * 1024,
  d1QueriesPerInvocation: 50,
  resendEmailsPerDay: 100,
  resendEmailsPerMonth: 3_000,
} as const;
/** Meta interna: planejar até 50% de cada limite (folga para picos, erros, retries e crescimento). Alerta em 60%, ação em 80%. */
export const TARGET_SHARE = 0.5;

/** HIPÓTESES de uso por conta ativa em um dia. São suposições explícitas, não medições: ajuste com os dados reais da homologação. */
export type Hypotheses = {
  appOpens: number;          // vezes que o app é aberto (cada abertura: checar sessão + 1 sincronização sem mudanças)
  focusSyncs: number;        // sincronizações sem mudanças ao voltar o foco para a janela (mínimo de 15 s entre elas)
  editBursts: number;        // rajadas de edição sincronizadas (cada uma: pull + push + pull)
  quotePublishes: number;    // links de orçamento publicados
  settingsVisits: number;    // visitas a Configurações (lista de links + lista de dispositivos)
  publicViews: number;       // aberturas de links públicos por clientes (inclui pré-visualização do WhatsApp)
  loginsPerDay: number;      // logins por e-mail por dia (sessão dura 30 dias de inatividade, no máx. 90)
  resendFactor: number;      // e-mails por login (reenvios, erros digitados)
};
export const TYPICAL: Hypotheses = { appOpens: 4, focusSyncs: 20, editBursts: 25, quotePublishes: 2, settingsVisits: 3, publicViews: 12, loginsPerDay: 0.03, resendFactor: 1.5 };
/** Cenário pessimista: 2,5x o uso típico de sincronização (usuário muito ativo) e mais logins. */
export const HEAVY: Hypotheses = { appOpens: 8, focusSyncs: 60, editBursts: 80, quotePublishes: 5, settingsVisits: 8, publicViews: 40, loginsPerDay: 0.1, resendFactor: 2 };

const find = (rows: Measured[], start: string): Measured => { const r = rows.find(x => x.name.startsWith(start)); if (!r) throw new Error(`cenário não medido: ${start}`); return r; };
export type Totals = { requests: number; rowsRead: number; rowsWritten: number };
const add = (a: Totals, m: Measured, times: number): Totals => ({ requests: a.requests + m.requests * times, rowsRead: a.rowsRead + m.rowsRead * times, rowsWritten: a.rowsWritten + m.rowsWritten * times });

/** Consumo diário de UMA conta ativa, a partir das medições e das hipóteses. */
export function perAccountPerDay(rows: Measured[], h: Hypotheses): Totals & { emails: number } {
  const open = find(rows, 'Abrir o app já logado'), idle = find(rows, 'Sincronização sem mudanças'), edit = find(rows, 'Editar 1 ingrediente'), pay = find(rows, 'Registrar um recebimento');
  const pub = find(rows, 'Publicar link'), view = find(rows, 'Cliente abre'), list = find(rows, 'Listar links'), login = find(rows, 'Login');
  let t: Totals = { requests: 0, rowsRead: 0, rowsWritten: 0 };
  t = add(t, open, h.appOpens); t = add(t, idle, h.appOpens + h.focusSyncs);
  t = add(t, edit, h.editBursts * 0.7); t = add(t, pay, h.editBursts * 0.3);
  t = add(t, pub, h.quotePublishes); t = add(t, view, h.publicViews); t = add(t, list, h.settingsVisits * 2); // lista de links + de dispositivos (custo parecido)
  t = add(t, login, h.loginsPerDay);
  return { ...t, emails: h.loginsPerDay * h.resendFactor };
}

export type Row = { accounts: number; requests: number; reads: number; writes: number; emails: number; share: { requests: number; reads: number; writes: number; emailsDay: number } };
export function scale(per: ReturnType<typeof perAccountPerDay>, accounts: number): Row {
  const requests = per.requests * accounts, reads = per.rowsRead * accounts, writes = per.rowsWritten * accounts, emails = per.emails * accounts;
  return { accounts, requests, reads, writes, emails, share: { requests: requests / FREE_LIMITS.workerRequestsPerDay, reads: reads / FREE_LIMITS.d1RowsReadPerDay, writes: writes / FREE_LIMITS.d1RowsWrittenPerDay, emailsDay: emails / FREE_LIMITS.resendEmailsPerDay } };
}
/** Maior número de contas ativas que mantém TODAS as métricas dentro da meta (50%) do limite gratuito. */
export function accountsWithinTarget(per: ReturnType<typeof perAccountPerDay>): { requests: number; reads: number; writes: number; emails: number; limiting: string; accounts: number } {
  const c = { requests: FREE_LIMITS.workerRequestsPerDay * TARGET_SHARE / per.requests, reads: FREE_LIMITS.d1RowsReadPerDay * TARGET_SHARE / per.rowsRead, writes: FREE_LIMITS.d1RowsWrittenPerDay * TARGET_SHARE / per.rowsWritten, emails: FREE_LIMITS.resendEmailsPerDay * TARGET_SHARE / per.emails };
  const entries = Object.entries(c) as [keyof typeof c, number][]; const [limiting, min] = entries.sort((a, b) => a[1] - b[1])[0];
  return { ...c, limiting, accounts: Math.floor(min) };
}
