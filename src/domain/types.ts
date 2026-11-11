export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un';
/** Unidades de medida de uso culinário: xícara (240 ml), colher de sopa (15 ml) e colher de chá (5 ml). */
export type MeasureUnit = Unit | 'xic' | 'cs' | 'cc';
/** gramsPerCup: quanto pesa 1 xícara (240 ml) do ingrediente; necessário para converter volume em peso. */
export type Ingredient = { id: string; name: string; purchaseQuantity: number; unit: Unit; purchasePrice: number; gramsPerCup?: number };
/** unit ausente = mesma unidade de compra do ingrediente (dados anteriores à conversão). */
export type RecipeItem = { ingredientId: string; quantity: number; unit?: MeasureUnit };
export type Recipe = { id: string; name: string; yield: number; items: RecipeItem[]; packagingPerUnit: number; laborTotal: number; extraTotal: number; desiredMargin: number };
export type Order = { id: string; customer: string; recipeId: string; quantity: number; unitPrice: number; deliveryDate: string; status: 'Orçamento' | 'Confirmado' | 'Produção' | 'Entregue'; deposit: number; createdAt: string };
export type DataSet = { schemaVersion: 1; ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[] };
