import { toCents2 } from './money';

/** Um produto da encomenda para o cálculo: quantidade, preço de venda e (opcional) custo unitário congelado ou estimado. */
export type FinancialItem = { quantity: number; unitPrice: number; costPerUnit?: number };
export type OrderFinancialInput = {
  items: readonly FinancialItem[];
  /** Valor cobrado pelas embalagens adicionais da encomenda (congelado no pedido). */
  packagingCharge?: number;
  /** Custo total congelado dos adicionais. Não altera a cobrança; entra no custo e no lucro. */
  additionalPackagingCost?: number;
  received?: number;
};

/** Subtotal de venda de um item, em centavos exatos: quantidade × preço unitário. */
export const itemSubtotal = (item: Pick<FinancialItem, 'quantity' | 'unitPrice'>): number => toCents2(item.quantity * item.unitPrice);

/**
 * Fonte única dos números de uma encomenda.
 *   subtotalProdutos = Σ (quantidade × preço unitário) de cada item (cada subtotal arredondado a centavos)
 *   totalCobrado     = subtotalProdutos + cobrança das embalagens adicionais
 *   custoEstimado    = Σ (custo unitário × quantidade) de cada item + custo das embalagens adicionais
 * O custo fica indefinido se QUALQUER item não tiver custo (nunca se assume zero).
 */
export function calculateOrderFinancials(input: OrderFinancialInput) {
  const lines = input.items.map(item => ({ subtotal: itemSubtotal(item), cost: item.costPerUnit === undefined ? undefined : item.costPerUnit * item.quantity }));
  const productsTotal = toCents2(lines.reduce((sum, line) => sum + line.subtotal, 0));
  const packagingCharge = toCents2(input.packagingCharge ?? 0);
  const totalCharged = toCents2(productsTotal + packagingCharge);
  const costKnown = lines.every(line => line.cost !== undefined);
  const estimatedCost = !costKnown ? undefined : toCents2(lines.reduce((sum, line) => sum + (line.cost ?? 0), 0) + (input.additionalPackagingCost ?? 0));
  return {
    lines,
    productsTotal,
    packagingCharge,
    totalCharged,
    estimatedCost,
    estimatedProfit: estimatedCost === undefined ? undefined : toCents2(totalCharged - estimatedCost),
    balanceDue: Math.max(0, toCents2(totalCharged - (input.received ?? 0))),
  };
}
