import { asOrder } from './helpers/orders';
import { describe, expect, it } from 'vitest';
import { addDays, availableMinutes, buildAgenda, daysBetween, forecastUntil, formatMinutes, isPending, orderMinutes, weekdayOf, workloadForecast } from '../src/domain/schedule';
import type { DataSet, Order, Recipe } from '../src/domain/types';
import { emptyDataSet } from '../src/sync/engine';

const TODAY = '2026-11-11'; // quarta-feira
const recipe = (over: Partial<Recipe> = {}): Recipe => ({ id: 'r', name: 'Bolo', yield: 10, items: [], packagingPerUnit: 0, laborTotal: 0, extraTotal: 0, desiredMargin: 20, prepMinutes: 120, ...over });
const ord = (id: string, deliveryDate: string, over: Partial<Order> = {}): Order => asOrder({ id, customer: `Cliente ${id}`, recipeId: 'r', quantity: 10, unitPrice: 5, deposit: 0, deliveryDate, status: 'Confirmado', createdAt: `2026-11-0${id.length}T10:00:00.000Z`, ...over });
const data = (orders: Order[], settings: DataSet['settings'] = { cupSizeMl: 240, dailyCapacityMinutes: 240 }, recipes: Recipe[] = [recipe()]): DataSet => ({ ...emptyDataSet(), recipes, orders, settings });

describe('Datas', () => {
  it('soma dias e dias da semana corretamente, inclusive virada de mês e ano bissexto', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01'); expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); expect(addDays('2026-11-11', -11)).toBe('2026-10-31');
    expect(weekdayOf('2026-11-11')).toBe(3); expect(weekdayOf('2026-11-15')).toBe(0);
    expect(daysBetween('2026-11-01', '2026-11-11')).toBe(10); expect(daysBetween('2026-11-11', '2026-11-01')).toBe(-10);
  });
});

describe('Agenda', () => {
  it('separa atrasados, hoje, próximos dias e depois, ordenados por data', () => {
    const orders = [ord('a', '2026-11-09'), ord('b', TODAY), ord('c', '2026-11-12'), ord('d', '2026-11-17'), ord('e', '2026-11-18'), ord('f', '2026-11-10')];
    const ag = buildAgenda(orders, TODAY);
    expect(ag.overdue.map(x => [x.order.id, x.daysLate])).toEqual([['a', 2], ['f', 1]]);
    expect(ag.today.map(o => o.id)).toEqual(['b']);
    expect(ag.week).toHaveLength(6); expect(ag.week[0]).toMatchObject({ date: '2026-11-12', weekday: 'Quinta' });
    expect(ag.week.find(d => d.date === '2026-11-12')!.orders.map(o => o.id)).toEqual(['c']);
    expect(ag.week[5].date).toBe('2026-11-17'); expect(ag.week[5].orders.map(o => o.id)).toEqual(['d']);
    expect(ag.later.map(o => o.id)).toEqual(['e']);
  });
  it('entregues e orçamentos não entram (a menos que se peça); atraso só para o que falta entregar', () => {
    const orders = [ord('a', '2026-11-01', { status: 'Entregue' }), ord('b', '2026-11-01', { status: 'Orçamento' }), ord('c', '2026-11-01', { status: 'Produção' })];
    expect(buildAgenda(orders, TODAY).overdue.map(x => x.order.id)).toEqual(['c']);
    expect(buildAgenda(orders, TODAY, true).overdue.map(x => x.order.id).sort()).toEqual(['b', 'c']);
    expect(isPending(orders[0])).toBe(false);
  });
  it('um pedido que vence hoje não é atrasado; amanhã não é "hoje"', () => {
    const ag = buildAgenda([ord('a', TODAY), ord('b', '2026-11-12')], TODAY);
    expect(ag.overdue).toEqual([]); expect(ag.today).toHaveLength(1);
  });
  it('lista vazia gera a estrutura completa', () => {
    const ag = buildAgenda([], TODAY);
    expect(ag.overdue).toEqual([]); expect(ag.today).toEqual([]); expect(ag.later).toEqual([]); expect(ag.week.every(d => d.orders.length === 0)).toBe(true);
  });
});

describe('Análise de prazo (estimativa)', () => {
  it('minutos de um pedido são proporcionais ao rendimento', () => {
    expect(orderMinutes(recipe(), 10)).toBe(120); expect(orderMinutes(recipe(), 5)).toBe(60); expect(orderMinutes(recipe(), 25)).toBe(300);
    expect(orderMinutes(recipe({ prepMinutes: undefined }), 10)).toBeUndefined(); expect(orderMinutes(undefined, 10)).toBeUndefined();
  });
  it('capacidade conta só os dias de trabalho (padrão segunda a sábado)', () => {
    const d = data([]);
    expect(availableMinutes(d, '2026-11-11', '2026-11-11')).toBe(240); // quarta
    expect(availableMinutes(d, '2026-11-11', '2026-11-16')).toBe(240 * 5); // qua, qui, sex, sáb, (dom não), seg
    const custom = data([], { cupSizeMl: 240, dailyCapacityMinutes: 100, workWeekdays: [1, 3] });
    expect(availableMinutes(custom, '2026-11-11', '2026-11-17')).toBe(200); // só segunda e quarta: qua 11 e seg 16 = 2 dias × 100 min
  });
  it('classifica folga, apertado e sobrecarga pela razão carga/capacidade', () => {
    const at = (qty: number) => forecastUntil(data([ord('a', TODAY, { quantity: qty })]), TODAY, TODAY).status; // capacidade do dia: 240 min; 12 min por unidade
    expect(at(10)).toBe('ok'); // 120 min = 50%
    expect(at(16)).toBe('ok'); // 192 min = 80%: no limite
    expect(at(18)).toBe('tight'); // 216 min = 90%
    expect(at(20)).toBe('tight'); // 240 min = 100%
    expect(at(21)).toBe('overload'); // 252 min > 240
  });
  it('a carga é ACUMULADA: pedidos de dias anteriores e atrasados consomem a capacidade', () => {
    const d = data([ord('a', '2026-11-09'), ord('b', '2026-11-12', { quantity: 10 })]); // atrasado (120) + quinta (120)
    expect(forecastUntil(d, TODAY, '2026-11-11')).toMatchObject({ requiredMinutes: 120, availableMinutes: 240, status: 'ok' });
    expect(forecastUntil(d, TODAY, '2026-11-12')).toMatchObject({ requiredMinutes: 240, availableMinutes: 480, status: 'ok' });
  });
  it('simula aceitar um novo pedido', () => {
    const d = data([ord('a', TODAY, { quantity: 10 })]);
    expect(forecastUntil(d, TODAY, TODAY, { recipeId: 'r', quantity: 10 }).status).toBe('tight'); // 240/240
    expect(forecastUntil(d, TODAY, TODAY, { recipeId: 'r', quantity: 20 }).status).toBe('overload');
    expect(forecastUntil(d, TODAY, '2026-11-13', { recipeId: 'r', quantity: 20 }).status).toBe('ok');
  });
  it('sem informações suficientes: "desconhecido" com o motivo, nunca um chute', () => {
    expect(forecastUntil(data([ord('a', TODAY)], { cupSizeMl: 240 }), TODAY, TODAY)).toMatchObject({ status: 'unknown', reason: 'no-capacity' });
    expect(forecastUntil(data([ord('a', TODAY)], { cupSizeMl: 240, dailyCapacityMinutes: 0 }), TODAY, TODAY)).toMatchObject({ status: 'unknown', reason: 'no-capacity' });
    const noPrep = data([], undefined, [recipe({ prepMinutes: undefined })]);
    expect(forecastUntil(noPrep, TODAY, TODAY, { recipeId: 'r', quantity: 5 })).toMatchObject({ status: 'unknown', reason: 'no-prep-time' });
    expect(forecastUntil(data([]), TODAY, '2026-11-01')).toMatchObject({ status: 'unknown', reason: 'past-date' });
    expect(forecastUntil(data([]), TODAY, 'amanhã')).toMatchObject({ status: 'unknown', reason: 'invalid' });
  });
  it('pedidos sem tempo informado não entram na conta e são listados', () => {
    const d = data([ord('a', TODAY), ord('b', TODAY, { recipeId: 'sem-tempo' })], undefined, [recipe(), recipe({ id: 'sem-tempo', prepMinutes: undefined })]);
    const f = forecastUntil(d, TODAY, TODAY);
    expect(f.ignored).toEqual(['b']); expect(f.requiredMinutes).toBe(120);
  });
  it('dia sem dia de trabalho disponível é sobrecarga se houver carga', () => {
    const sundayOnly = data([ord('a', '2026-11-15')], { cupSizeMl: 240, dailyCapacityMinutes: 240, workWeekdays: [3] });
    expect(forecastUntil(sundayOnly, '2026-11-14', '2026-11-15').status).toBe('overload');
  });
  it('a previsão por dia lista só os dias com pedidos; o primeiro dia inclui os atrasados', () => {
    const d = data([ord('a', '2026-11-08'), ord('b', '2026-11-13'), ord('c', '2026-11-13')]);
    const rows = workloadForecast(d, TODAY, 7);
    expect(rows.map(r => [r.date, r.orders])).toEqual([[TODAY, 1], ['2026-11-13', 2]]);
    expect(rows.every(r => ['ok', 'tight', 'overload'].includes(r.status))).toBe(true);
  });
  it('formata minutos', () => { expect(formatMinutes(45)).toBe('45 min'); expect(formatMinutes(60)).toBe('1 h'); expect(formatMinutes(135)).toBe('2 h 15 min'); });
});
