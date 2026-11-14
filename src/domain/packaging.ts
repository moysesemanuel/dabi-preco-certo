import type { Packaging, RecipePackagingItem } from './types';

export function packagingUnitCost(price: number, quantity: number): number {
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Preço e quantidade da embalagem inválidos.');
  return price / quantity;
}

export function suggestPackagingQuantity(productQuantity: number, capacity: number): number {
  if (!Number.isFinite(productQuantity) || productQuantity <= 0 || !Number.isFinite(capacity) || capacity <= 0) throw new Error('Quantidade e capacidade devem ser maiores que zero.');
  return Math.ceil(productQuantity / capacity);
}

export function recipePackagingCostPerUnit(items: RecipePackagingItem[] = [], packagings: Packaging[] = []): number {
  return items.reduce((total, item) => {
    const packaging = packagings.find(p => p.id === item.packagingId);
    if (!packaging || !Number.isFinite(item.quantityPerUnit) || item.quantityPerUnit < 0) throw new Error('Embalagem associada inválida.');
    return total + packagingUnitCost(packaging.purchasePrice, packaging.purchaseQuantity) * item.quantityPerUnit;
  }, 0);
}
