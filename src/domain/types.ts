export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un';
/** Unidades de medida de uso culinário: xícara (240 ml), colher de sopa (15 ml) e colher de chá (5 ml). */
export type MeasureUnit = Unit | 'xic' | 'cs' | 'cc';
/**
 * densityGPerMl: densidade do ingrediente (g/mL), necessária para converter entre peso e volume.
 * gramsPerUnit: quanto pesa 1 unidade do ingrediente, necessário para converter unidade em peso.
 */
export type Ingredient = { id: string; name: string; purchaseQuantity: number; unit: Unit; purchasePrice: number; densityGPerMl?: number; gramsPerUnit?: number };
/** unit ausente = mesma unidade de compra do ingrediente (dados anteriores à conversão). */
export type RecipeItem = { ingredientId: string; quantity: number; unit?: MeasureUnit };
export type Recipe = { id: string; name: string; yield: number; items: RecipeItem[]; packagingPerUnit: number; laborTotal: number; extraTotal: number; desiredMargin: number };
/**
 * Custo unitário da receita NO MOMENTO em que a encomenda foi registrada. Nunca é recalculado com preços atuais.
 * Ausente em encomendas anteriores ao registro de custos (ou quando o custo não era calculável): nesses casos
 * o app só pode ESTIMAR pelo custo atual e deve deixar isso claro.
 */
export type CostSnapshot = { costPerUnit: number; capturedAt: string };
export type Order = { id: string; customer: string; recipeId: string; quantity: number; unitPrice: number; deliveryDate: string; status: 'Orçamento' | 'Confirmado' | 'Produção' | 'Entregue'; deposit: number; createdAt: string; costSnapshot?: CostSnapshot };
export type Settings = { cupSizeMl: number };
/** Versão 2: encomendas podem ter `costSnapshot`. Versão 1 (sem snapshot) é migrada sem inventar custos históricos. */
export const CURRENT_SCHEMA_VERSION = 2;
export type DataSet = { schemaVersion: 2; ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[]; settings?: Settings };
