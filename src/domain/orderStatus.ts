import type { OrderStatus } from './types';

/**
 * Confirmação automática por pagamento: um ORÇAMENTO que recebe um valor efetivamente registrado (> 0) passa a CONFIRMADO.
 * Nenhum outro status muda: Confirmado não avança para Em produção, e Em produção/Entregue nunca voltam.
 * Só é aplicada a um evento de recebimento novo (sinal na criação, aumento do sinal, novo recebimento ou soma de recebimentos
 * numa reconciliação); nunca no carregamento, na migração ou ao remover/corrigir um recebimento.
 */
export const statusAfterReceipt = (status: OrderStatus, amountReceived: number): OrderStatus =>
  status === 'Orçamento' && Number.isFinite(amountReceived) && amountReceived > 0 ? 'Confirmado' : status;
