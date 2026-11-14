/**
 * Reconciliação financeira explícita. Quando duas pontas mexem no dinheiro da MESMA encomenda, a versão do servidor é aplicada na sincronização
 * (o dinheiro nunca é decidido em silêncio), mas o que esta ponta fez fica registrado como pendência e só sai por escolha do usuário:
 *  - "merge" (somar): acrescenta à encomenda os recebimentos lançados aqui (ignora os que já existem), sem passar do total;
 *    se a encomenda foi excluída no outro dispositivo, recria uma CÓPIA (novo id) com os dados locais.
 *  - "keep-server": mantém só o que o servidor tem (a tela exige confirmar o descarte dos valores listados).
 * Nenhuma das duas altera outra coisa além do dinheiro dessa pendência; erros de regra (passa do total, receita ausente) são lançados.
 */
import { uniqueQuoteCode } from '../../shared/quoteCode';
import { orderTotal, totalReceived } from '../domain/payments';
import { statusAfterReceipt } from '../domain/orderStatus';
import { toCents2 } from '../domain/money';
import type { DataSet, Order } from '../domain/types';
import type { ConflictRecord } from './engine';

export type ReconcileAction = 'merge' | 'keep-server';
export type ReconcileResult = { data: DataSet; conflict: ConflictRecord };

export function reconcileFinancial(data: DataSet, conflict: ConflictRecord, action: ReconcileAction, now: Date, newId: () => string = () => crypto.randomUUID()): ReconcileResult {
  if (!conflict.financial || conflict.resolution) throw new Error('Esta pendência não precisa de reconciliação.');
  const resolved: ConflictRecord = { ...conflict, resolution: { action, at: now.toISOString() } };
  if (action === 'keep-server') return { data, conflict: resolved };

  const f = conflict.financial;
  const existing = data.orders.find(o => o.id === conflict.entityId);
  if (!existing) {
    // Encomenda excluída no outro dispositivo: recria uma cópia com os recebimentos daqui.
    const local = conflict.local as Order | null;
    if (!local) throw new Error('Não há mais dados locais para recuperar.');
    if (local.items.some(item => !data.recipes.some(r => r.id === item.recipeId))) throw new Error('A receita desta encomenda não existe mais. Recrie a receita antes de recuperar a encomenda.');
    // A cópia é uma encomenda nova: recebe o seu próprio código de atendimento (o do original continua reservado).
    const used = new Set(data.orders.map(o => o.quoteCode).filter((c): c is string => !!c));
    const copy: Order = { ...local, id: newId(), quoteCode: uniqueQuoteCode(used) };
    if (toCents2(totalReceived(copy)) > orderTotal(copy) + 0.005) throw new Error('Os recebimentos passam do total da encomenda.');
    return { data: { ...data, orders: [...data.orders, copy] }, conflict: resolved };
  }

  const have = new Set((existing.payments ?? []).map(p => p.id));
  const missing = f.addedPayments.filter(p => !have.has(p.id));
  let next: Order = { ...existing, ...(missing.length ? { payments: [...(existing.payments ?? []), ...missing] } : {}) };
  if (f.deposit && existing.deposit !== f.deposit.local) next = { ...next, deposit: f.deposit.local };
  // Somar recebimentos é um recebimento novo para esta versão do pedido: um orçamento passa a confirmado (nunca o contrário).
  const added = toCents2(totalReceived(next) - totalReceived(existing));
  if (added > 0) next = { ...next, status: statusAfterReceipt(existing.status, added) };
  if (toCents2(totalReceived(next)) > orderTotal(next) + 0.005) throw new Error('Somar estes recebimentos passaria do total da encomenda. Ajuste os recebimentos manualmente e use "Manter a versão do servidor".');
  return { data: { ...data, orders: data.orders.map(o => (o.id === next.id ? next : o)) }, conflict: resolved };
}

/** Texto curto do que está em jogo, para a tela. */
export function describeFinancial(c: ConflictRecord): string[] {
  const f = c.financial; if (!f) return [];
  const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return [
    ...f.addedPayments.map(p => `Recebimento lançado aqui e ausente no servidor: ${brl(p.amount)} em ${p.receivedAt.split('-').reverse().join('/')}${p.note ? ` (${p.note})` : ''}`),
    ...f.removedPayments.map(p => `Recebimento removido aqui, mas ainda existente no servidor: ${brl(p.amount)} em ${p.receivedAt.split('-').reverse().join('/')}`),
    ...(f.deposit ? [`Sinal alterado aqui para ${brl(f.deposit.local)} (servidor: ${f.deposit.server === null ? 'encomenda excluída' : brl(f.deposit.server)})`] : []),
  ];
}
