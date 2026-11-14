import { toCents2 } from './money';

export type OrderFinancialInput = {
  quantity: number;
  unitPrice: number;
  packagingCharge?: number;
  /** Custo congelado por unidade da receita, que já inclui as embalagens da receita. */
  recipeCostPerUnit?: number;
  /** Custo total congelado dos adicionais. Não altera a cobrança; é usado no custo e lucro. */
  additionalPackagingCost?: number;
  received?: number;
};

export function calculateOrderFinancials(input: OrderFinancialInput) {
  const productsTotal = toCents2(input.quantity * input.unitPrice);
  const packagingCharge = toCents2(input.packagingCharge ?? 0);
  const totalCharged = toCents2(productsTotal + packagingCharge);
  const estimatedCost = input.recipeCostPerUnit === undefined
    ? undefined
    : toCents2(input.recipeCostPerUnit * input.quantity + (input.additionalPackagingCost ?? 0));
  return {
    productsTotal,
    packagingCharge,
    totalCharged,
    estimatedCost,
    estimatedProfit: estimatedCost === undefined ? undefined : toCents2(totalCharged - estimatedCost),
    balanceDue: Math.max(0, toCents2(totalCharged - (input.received ?? 0))),
  };
}
