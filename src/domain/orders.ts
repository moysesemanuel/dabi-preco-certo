/**
 * Encomendas com vários produtos (itens). Toda regra de criação e edição fica aqui, fora dos componentes React.
 *
 * Regras:
 *  - Uma encomenda tem de 1 a ORDER_ITEM_LIMIT itens; cada item tem receita, quantidade e preço unitário próprios.
 *  - A mesma receita não pode aparecer em dois itens (evita duplicidade acidental): some as quantidades em um único item.
 *  - Custos históricos: ao criar um item, o custo atual da receita é congelado no item (`costSnapshot`) junto com o nome.
 *    Ao editar, um item que mantém a mesma receita CONSERVA o custo e o nome registrados (só quantidade e preço mudam,
 *    por escolha explícita); um item novo ou que trocou de receita recebe o custo atual. Nada é recalculado em silêncio.
 *  - Embalagens adicionais pertencem à encomenda; a cobrança é congelada em `packagingCharge`.
 *  - Sinal positivo na criação, ou aumento do sinal na edição, confirma um orçamento (`statusAfterReceipt`).
 */
import { isIsoDate } from '../../shared/dataset';
import { captureCostSnapshot, orderPackagingTotal } from './orderCost';
import { isMoney, isPositiveQuantity, toCents2 } from './money';
import { statusAfterReceipt } from './orderStatus';
import { orderTotal, totalReceived } from './payments';
import type { DataSet, Order, OrderItem, OrderPackagingSnapshot, OrderStatus, Recipe } from './types';

export const ORDER_ITEM_LIMIT = 50;
/** Item em edição: `id` presente = item já registrado na encomenda. */
export type OrderItemDraft = { id?: string; recipeId: string; quantity: number; unitPrice: number };
type Ids = { newItemId?: () => string };
const defaultItemId = () => crypto.randomUUID();

/** Nome exibido de um item: o registrado na encomenda; em itens antigos (sem registro), o nome atual da receita. */
export const itemName = (item: OrderItem, recipes: readonly Recipe[]): string => item.recipeName ?? recipes.find(r => r.id === item.recipeId)?.name ?? 'Receita indisponível';
export const orderRecipeIds = (order: Pick<Order, 'items'>): string[] => order.items.map(item => item.recipeId);
const qty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const joinNames = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`);

/** Resumo para listas: "Brigadeiro · 50 un." ou "3 itens — Brigadeiro, Beijinho e Bolo" (com "e mais N" quando são muitos). */
export function itemsSummary(order: Pick<Order, 'items'>, recipes: readonly Recipe[], maxNames = 3): string {
  const names = order.items.map(item => itemName(item, recipes));
  if (order.items.length === 1) return `${names[0]} · ${qty(order.items[0].quantity)} un.`;
  const shown = names.length > maxNames ? [...names.slice(0, maxNames), `mais ${names.length - maxNames}`] : names;
  return `${order.items.length} itens — ${joinNames(shown)}`;
}
/** Todos os nomes de produto da encomenda (para a busca encontrar o pedido por qualquer receita). */
export const orderProductText = (order: Pick<Order, 'items'>, recipes: readonly Recipe[]): string => order.items.map(item => itemName(item, recipes)).join(' ');

/** Valida a lista de itens. Lança Error com mensagem em português. */
export function validateItemDrafts(data: DataSet, drafts: readonly OrderItemDraft[]): void {
  if (!drafts.length) throw new Error('Adicione pelo menos um produto à encomenda.');
  if (drafts.length > ORDER_ITEM_LIMIT) throw new Error(`Uma encomenda pode ter no máximo ${ORDER_ITEM_LIMIT} produtos.`);
  const seen = new Set<string>();
  drafts.forEach((draft, index) => {
    const recipe = data.recipes.find(r => r.id === draft.recipeId);
    if (!recipe) throw new Error(`Receita do produto ${index + 1} não encontrada. Escolha uma receita.`);
    if (!isPositiveQuantity(draft.quantity)) throw new Error(`Informe uma quantidade válida para "${recipe.name}".`);
    if (!isMoney(draft.unitPrice)) throw new Error(`Informe um preço unitário válido para "${recipe.name}".`);
    if (seen.has(recipe.id)) throw new Error(`A receita "${recipe.name}" aparece em mais de um item. Some as quantidades em um único item.`);
    seen.add(recipe.id);
  });
}

/** Monta os itens finais, preservando o histórico dos itens já registrados (veja as regras no topo do arquivo). */
function buildItems(data: DataSet, drafts: readonly OrderItemDraft[], existing: readonly OrderItem[], now: Date, newItemId: () => string): OrderItem[] {
  const used = new Set<string>();
  return drafts.map(draft => {
    const previous = draft.id ? existing.find(item => item.id === draft.id) : undefined;
    const unitPrice = toCents2(draft.unitPrice);
    let id = previous?.id ?? newItemId();
    while (used.has(id)) id = newItemId();
    used.add(id);
    if (previous && previous.recipeId === draft.recipeId) return { ...previous, id, quantity: draft.quantity, unitPrice };
    const recipe = data.recipes.find(r => r.id === draft.recipeId)!;
    const costSnapshot = captureCostSnapshot(recipe, data, now);
    return { id, recipeId: recipe.id, recipeName: recipe.name, quantity: draft.quantity, unitPrice, ...(costSnapshot ? { costSnapshot } : {}) };
  });
}

export type NewOrderDraft = { customer: string; items: OrderItemDraft[]; deliveryDate: string; deposit: number; packagingItems?: OrderPackagingSnapshot[]; status?: OrderStatus };

/** Cria uma encomenda nova. Com sinal positivo, nasce CONFIRMADA (o sinal é o recebimento efetivo registrado junto). */
export function createOrder(data: DataSet, draft: NewOrderDraft, opts: { id: string; quoteCode: string; now?: Date } & Ids): Order {
  const now = opts.now ?? new Date();
  if (!draft.customer.trim()) throw new Error('Informe o nome do cliente.');
  if (!isIsoDate(draft.deliveryDate)) throw new Error('Informe a data de entrega.');
  validateItemDrafts(data, draft.items);
  if (!isMoney(draft.deposit)) throw new Error('Sinal inválido.');
  const packagingItems = draft.packagingItems ?? [];
  if (packagingItems.some(p => !isPositiveQuantity(p.quantity))) throw new Error('Informe a quantidade de cada embalagem adicional.');
  const items = buildItems(data, draft.items, [], now, opts.newItemId ?? defaultItemId);
  const packagingCharge = toCents2(orderPackagingTotal({ packagingItems }));
  const deposit = toCents2(draft.deposit);
  if (deposit > orderTotal({ items, packagingCharge })) throw new Error('O sinal não pode ser maior que o total da encomenda.');
  return {
    id: opts.id, quoteCode: opts.quoteCode, customer: draft.customer.trim(), items, deliveryDate: draft.deliveryDate,
    status: statusAfterReceipt(draft.status ?? 'Orçamento', deposit), deposit, createdAt: now.toISOString(),
    packagingItems, packagingCharge,
  };
}

export type OrderPatch = { customer: string; items: OrderItemDraft[]; deliveryDate: string; deposit: number; packagingItems?: OrderPackagingSnapshot[]; packagingCharge?: number };

/**
 * Atualiza os dados de uma encomenda. Status, recebimentos, código, data de criação e id são preservados.
 * Itens: veja as regras de histórico no topo do arquivo. Aumentar o sinal de um ORÇAMENTO o confirma (novo recebimento).
 */
export function updateOrder(data: DataSet, id: string, patch: OrderPatch, now: Date = new Date(), ids: Ids = {}): DataSet {
  const existing = data.orders.find(o => o.id === id);
  if (!existing) throw new Error('Encomenda não encontrada.');
  if (!patch.customer.trim() || !isIsoDate(patch.deliveryDate)) throw new Error('Informe cliente e data de entrega.');
  validateItemDrafts(data, patch.items);
  if (!isMoney(patch.deposit) || (patch.packagingCharge !== undefined && !isMoney(patch.packagingCharge))) throw new Error('Sinal ou cobrança de embalagens inválida.');
  if ((patch.packagingItems ?? []).some(p => !isPositiveQuantity(p.quantity))) throw new Error('Informe a quantidade de cada embalagem adicional.');
  const items = buildItems(data, patch.items, existing.items, now, ids.newItemId ?? defaultItemId);
  const deposit = toCents2(patch.deposit);
  const packagingCharge = toCents2(patch.packagingCharge ?? existing.packagingCharge ?? 0);
  const total = orderTotal({ items, packagingCharge });
  if (deposit > total) throw new Error('O sinal não pode ser maior que o total.');
  // Sem crédito nem reembolso: o novo total não pode ficar abaixo do que já foi recebido.
  if (totalReceived({ deposit, payments: existing.payments }) > total) throw new Error('O total não pode ficar abaixo do que já foi recebido.');
  const status = deposit > existing.deposit ? statusAfterReceipt(existing.status, toCents2(deposit - existing.deposit)) : existing.status;
  const next: Order = { ...existing, customer: patch.customer.trim(), items, deliveryDate: patch.deliveryDate, deposit, status, packagingCharge,
    ...(patch.packagingItems ? { packagingItems: patch.packagingItems } : {}) };
  return { ...data, orders: data.orders.map(o => (o.id === id ? next : o)) };
}
