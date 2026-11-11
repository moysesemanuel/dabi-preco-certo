export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un';
export type Ingredient = { id: string; name: string; purchaseQuantity: number; unit: Unit; purchasePrice: number };
export type RecipeItem = { ingredientId: string; quantity: number };
export type Recipe = { id: string; name: string; yield: number; items: RecipeItem[]; packagingPerUnit: number; laborTotal: number; extraTotal: number; desiredMargin: number };
export type Order = { id: string; customer: string; recipeId: string; quantity: number; unitPrice: number; deliveryDate: string; status: 'Orçamento' | 'Confirmado' | 'Produção' | 'Entregue'; deposit: number; createdAt: string };
export type DataSet = { schemaVersion: 1; ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[] };
