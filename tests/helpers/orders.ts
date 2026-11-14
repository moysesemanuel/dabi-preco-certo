/** Testes antigos descrevem encomendas no formato de UMA receita; estes helpers aplicam a mesma conversão do app (item 'item-1'). */
import { LEGACY_ITEM_ID, upgradeOrderShape } from '../../shared/dataset';
import { updateOrder, type OrderPatch } from '../../src/domain/orders';
import type { DataSet, Order } from '../../src/domain/types';

export const asOrder = (legacy: Record<string, unknown>): Order => upgradeOrderShape(legacy) as Order;
type LegacyPatch = Omit<OrderPatch, 'items'> & { recipeId: string; quantity: number; unitPrice: number };
export const legacyPatch = ({ recipeId, quantity, unitPrice, ...rest }: LegacyPatch): OrderPatch => ({ ...rest, items: [{ id: LEGACY_ITEM_ID, recipeId, quantity, unitPrice }] });
/** `updateOrder` com o patch no formato antigo (o item existente é o 'item-1': custo histórico preservado se a receita não mudar). */
export const updateLegacyOrder = (data: DataSet, id: string, patch: LegacyPatch, now?: Date) => updateOrder(data, id, legacyPatch(patch), now);
