/**
 * Agenda de encomendas e análise de prazo (funções puras; "hoje" sempre vem de fora).
 * A análise de prazo é uma ESTIMATIVA simples com os tempos e a capacidade que a pessoa informou:
 * não é um planejamento de produção e não garante entrega.
 */
import { isIsoDate } from '../../shared/dataset';
import type { DataSet, Order, Recipe } from './types';

export const DEFAULT_WORK_WEEKDAYS = [1, 2, 3, 4, 5, 6]; // segunda a sábado
export const FORECAST_DISCLAIMER = 'Estimativa com base nos tempos e na capacidade que você informou. Não garante a entrega.';

const MS_DAY = 86_400_000;
const utc = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (iso: string, n: number): string => new Date(utc(iso) + n * MS_DAY).toISOString().slice(0, 10);
export const weekdayOf = (iso: string): number => new Date(utc(iso)).getUTCDay();
export const daysBetween = (from: string, to: string): number => Math.round((utc(to) - utc(from)) / MS_DAY);
export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Encomendas que ainda precisam ser entregues. Orçamentos (ainda não confirmados) ficam de fora, a menos que se peça. */
export const isPending = (o: Order, includeQuotes = false): boolean => o.status !== 'Entregue' && (includeQuotes || o.status !== 'Orçamento');

export type Agenda = {
  overdue: { order: Order; daysLate: number }[];
  today: Order[];
  /** Próximos 6 dias (amanhã até hoje + 6), sempre todos os dias, mesmo vazios. */
  week: { date: string; weekday: string; orders: Order[] }[];
  later: Order[];
};
const byDate = (a: Order, b: Order) => (a.deliveryDate < b.deliveryDate ? -1 : a.deliveryDate > b.deliveryDate ? 1 : a.createdAt < b.createdAt ? -1 : 1);

export function buildAgenda(orders: Order[], today: string, includeQuotes = false): Agenda {
  const pending = orders.filter(o => isPending(o, includeQuotes)).sort(byDate);
  const weekDates = Array.from({ length: 6 }, (_, i) => addDays(today, i + 1));
  return {
    overdue: pending.filter(o => o.deliveryDate < today).map(order => ({ order, daysLate: daysBetween(order.deliveryDate, today) })),
    today: pending.filter(o => o.deliveryDate === today),
    week: weekDates.map(date => ({ date, weekday: WEEKDAY_NAMES[weekdayOf(date)], orders: pending.filter(o => o.deliveryDate === date) })),
    later: pending.filter(o => o.deliveryDate > weekDates[5]),
  };
}

// ---------------- Análise de prazo ----------------
export type Viability = 'ok' | 'tight' | 'overload' | 'unknown';
export type Forecast = {
  status: Viability;
  /** Minutos necessários até a data (incluindo atrasos e pedidos anteriores). */
  requiredMinutes: number;
  /** Minutos disponíveis entre hoje e a data, nos dias de trabalho. */
  availableMinutes: number;
  /** Por que não foi possível estimar (status 'unknown'). */
  reason?: 'no-capacity' | 'no-prep-time' | 'past-date' | 'invalid';
  /** Pedidos sem tempo de produção informado (não entram na conta). */
  ignored: string[];
};
export const TIGHT_RATIO = 0.8;

/** Minutos para produzir `quantity` unidades da receita (proporcional ao rendimento). */
export const orderMinutes = (recipe: Recipe | undefined, quantity: number): number | undefined =>
  recipe?.prepMinutes && recipe.yield > 0 ? (recipe.prepMinutes * quantity) / recipe.yield : undefined;

const capacity = (data: DataSet) => ({ perDay: data.settings?.dailyCapacityMinutes, weekdays: data.settings?.workWeekdays ?? DEFAULT_WORK_WEEKDAYS });
/** Minutos disponíveis de `today` até `date` (inclusive), contando só os dias de trabalho. */
export function availableMinutes(data: DataSet, today: string, date: string): number {
  const { perDay, weekdays } = capacity(data);
  if (!perDay) return 0;
  let days = 0;
  for (let d = today; d <= date; d = addDays(d, 1)) if (weekdays.includes(weekdayOf(d))) days++;
  return days * perDay;
}
const classify = (required: number, available: number): Viability => (available <= 0 ? 'overload' : required / available <= TIGHT_RATIO ? 'ok' : required <= available ? 'tight' : 'overload');

/** Carga acumulada até `date`: todos os pedidos pendentes com entrega até essa data (os atrasados entram: precisam de tempo agora). */
function load(data: DataSet, date: string, extra?: { recipeId: string; quantity: number }) {
  const recipes = new Map(data.recipes.map(r => [r.id, r]));
  let required = 0;
  const ignored: string[] = [];
  for (const o of data.orders) {
    if (!isPending(o) || o.deliveryDate > date) continue;
    // Encomenda com vários produtos: soma o tempo de cada item; se algum não tem tempo de preparo, a encomenda fica de fora (e é sinalizada).
    const minutes = o.items.map(item => orderMinutes(recipes.get(item.recipeId), item.quantity));
    if (minutes.some(m => m === undefined)) ignored.push(o.id); else required += minutes.reduce<number>((sum, m) => sum + (m ?? 0), 0);
  }
  if (extra) { const m = orderMinutes(recipes.get(extra.recipeId), extra.quantity); if (m !== undefined) required += m; }
  return { required, ignored };
}

/** Viabilidade até uma data, considerando os pedidos já existentes. Com `candidate`, simula aceitar mais um pedido. */
export function forecastUntil(data: DataSet, today: string, date: string, candidate?: { recipeId: string; quantity: number }): Forecast {
  if (!isIsoDate(date) || !isIsoDate(today)) return { status: 'unknown', reason: 'invalid', requiredMinutes: 0, availableMinutes: 0, ignored: [] };
  const { perDay } = capacity(data);
  const { required, ignored } = load(data, date, candidate);
  const available = availableMinutes(data, today, date);
  if (date < today) return { status: 'unknown', reason: 'past-date', requiredMinutes: required, availableMinutes: 0, ignored };
  if (!perDay) return { status: 'unknown', reason: 'no-capacity', requiredMinutes: required, availableMinutes: 0, ignored };
  if (candidate && orderMinutes(data.recipes.find(r => r.id === candidate.recipeId), candidate.quantity) === undefined) return { status: 'unknown', reason: 'no-prep-time', requiredMinutes: required, availableMinutes: available, ignored };
  return { status: classify(required, available), requiredMinutes: Math.round(required), availableMinutes: available, ignored };
}

/** Uma linha por dia dos próximos `days` dias que tenha pedidos, com a carga acumulada. */
export function workloadForecast(data: DataSet, today: string, days = 14): (Forecast & { date: string; orders: number })[] {
  const out: (Forecast & { date: string; orders: number })[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const orders = data.orders.filter(o => isPending(o) && (i === 0 ? o.deliveryDate <= date : o.deliveryDate === date)).length;
    if (orders > 0) out.push({ date, orders, ...forecastUntil(data, today, date) });
  }
  return out;
}

export const formatMinutes = (m: number): string => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h${Math.round(m % 60) ? ` ${Math.round(m % 60)} min` : ''}`);
