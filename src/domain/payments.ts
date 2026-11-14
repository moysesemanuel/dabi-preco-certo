import { isIsoDate } from '../../shared/dataset';
import { isMoney, toCents2 } from './money';
import { calculateOrderFinancials } from './orderFinancials';
import type { DataSet, Order, Payment } from './types';

/** Total da encomenda, em centavos exatos. */
export const orderTotal = (o: Pick<Order, 'quantity' | 'unitPrice' | 'packagingCharge'>): number => calculateOrderFinancials(o).totalCharged;
/** Sinal + recebimentos. */
export const totalReceived = (o: Pick<Order, 'deposit' | 'payments'>): number => toCents2(o.deposit + (o.payments ?? []).reduce((s, p) => s + p.amount, 0));
/** Saldo pendente (nunca negativo). */
export const balanceDue = (o: Order): number => Math.max(0, toCents2(orderTotal(o) - totalReceived(o)));

/**
 * Registra um recebimento. Regra: o total recebido (sinal + recebimentos) nunca ultrapassa o total da encomenda.
 * Não há crédito nem reembolso nesta versão: o que passar do saldo é recusado.
 */
export function addPayment(data: DataSet, orderId: string, payment: Payment): DataSet {
  const order = data.orders.find(o => o.id === orderId);
  if (!order) throw new Error('Encomenda não encontrada.');
  if (!isMoney(payment.amount) || payment.amount <= 0) throw new Error('Informe um valor maior que zero.');
  const amount = toCents2(payment.amount);
  if (amount <= 0) throw new Error('Informe um valor maior que zero.');
  if (!isIsoDate(payment.receivedAt)) throw new Error('Informe uma data de recebimento válida.');
  if ((order.payments ?? []).some(p => p.id === payment.id)) throw new Error('Recebimento duplicado.');
  const due = balanceDue(order);
  if (amount > due) throw new Error(due > 0 ? 'O valor é maior que o saldo pendente.' : 'Esta encomenda já está totalmente paga.');
  const normalized = amount === payment.amount ? payment : { ...payment, amount };
  return { ...data, orders: data.orders.map(o => (o.id === orderId ? { ...o, payments: [...(o.payments ?? []), normalized] } : o)) };
}

/** Remove um recebimento lançado por engano (a tela pede confirmação). Sem recebimentos, o campo some do pedido. */
export function removePayment(data: DataSet, orderId: string, paymentId: string): DataSet {
  const order = data.orders.find(o => o.id === orderId);
  if (!order || !(order.payments ?? []).some(p => p.id === paymentId)) throw new Error('Recebimento não encontrado.');
  return { ...data, orders: data.orders.map(o => {
    if (o.id !== orderId) return o;
    const { payments, ...rest } = o;
    const left = (payments ?? []).filter(p => p.id !== paymentId);
    return left.length ? { ...rest, payments: left } : rest;
  }) };
}
