export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un';
/** Unidades de medida de uso culinário: xícara (240 ml), colher de sopa (15 ml) e colher de chá (5 ml). */
export type MeasureUnit = Unit | 'xic' | 'cs' | 'cc';
/**
 * densityGPerMl: densidade informada pelo usuário (g/mL), para converter entre peso e volume.
 * gramsPerUnit: quanto pesa 1 unidade do ingrediente, informado pelo usuário.
 * Sem valor informado, vale a referência do catálogo (`catalogRef`), veja `effectiveEquivalence`.
 */
export type Ingredient = { id: string; name: string; purchaseQuantity: number; unit: Unit; purchasePrice: number;
  /** Valor INFORMADO pelo usuário (tem prioridade sobre a referência do catálogo). Nunca é preenchido automaticamente pelo catálogo. */
  densityGPerMl?: number; gramsPerUnit?: number;
  /** Referência do catálogo adotada pelo usuário, com os valores congelados no momento da adoção. */
  catalogRef?: CatalogRef };
/** Referência de medidas escolhida no catálogo. Os valores ficam congelados: atualizar o catálogo nunca altera custos sem o usuário aceitar. */
export type CatalogRef = { id: string; variant: string; /** versão do catálogo em que foi adotada */ version: string; densityGPerMl?: number; gramsPerUnit?: number };
/** unit ausente = mesma unidade de compra do ingrediente (dados anteriores à conversão). */
export type RecipeItem = { ingredientId: string; quantity: number; unit?: MeasureUnit };
export type Packaging = { id: string; name: string; purchasePrice: number; purchaseQuantity: number; capacity?: number; active: boolean };
export type RecipePackagingItem = { packagingId: string; quantityPerUnit: number };
export type OrderPackagingSnapshot = { packagingId: string; name: string; quantity: number; unitCost: number };
export type RecipePackagingSnapshot = { packagingId: string; name: string; quantityPerUnit: number; unitCost: number };
export type Recipe = { id: string; name: string; yield: number; items: RecipeItem[]; packagingItems?: RecipePackagingItem[]; packagingPerUnit: number; laborTotal: number; extraTotal: number; desiredMargin: number; /** Minutos para produzir UMA receita (rendimento completo); opcional, usado só na análise de prazo. */ prepMinutes?: number };
/**
 * Custo unitário da receita NO MOMENTO em que a encomenda foi registrada. Nunca é recalculado com preços atuais.
 * Ausente em encomendas anteriores ao registro de custos (ou quando o custo não era calculável): nesses casos
 * o app só pode ESTIMAR pelo custo atual e deve deixar isso claro.
 */
export type CostSnapshot = { costPerUnit: number; capturedAt: string; packagingItems?: RecipePackagingSnapshot[] };
export const PAYMENT_METHODS = ['Pix', 'Dinheiro', 'Cartão', 'Transferência', 'Outro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Um recebimento (parcial ou final) de uma encomenda. O total recebido nunca ultrapassa o total do pedido. */
export type Payment = { id: string; amount: number; /** AAAA-MM-DD */ receivedAt: string; method?: PaymentMethod; note?: string };
/**
 * Um produto da encomenda. Cada item tem quantidade, preço de venda e custo próprios.
 * O subtotal de venda não é gravado: é sempre `quantity × unitPrice` em centavos (`orderItemSubtotal`), para nunca divergir.
 */
export type OrderItem = { /** Único dentro da encomenda. */ id: string; recipeId: string;
  /** Nome da receita quando o item foi registrado. Ausente em itens convertidos de encomendas antigas (o app mostra o nome atual). */
  recipeName?: string; quantity: number; unitPrice: number;
  /** Custo unitário congelado da receita (inclui as embalagens da receita). Ausente quando não havia registro histórico. */
  costSnapshot?: CostSnapshot };
export type OrderStatus = 'Orçamento' | 'Confirmado' | 'Produção' | 'Entregue';
export type Order = { id: string; customer: string;
  /** Produtos da encomenda (pelo menos um). Encomendas antigas, de uma receita só, viram um item (`LEGACY_ITEM_ID`). */
  items: OrderItem[]; deliveryDate: string; status: OrderStatus; deposit: number; createdAt: string;
  /** Embalagens adicionais da ENCOMENDA (caixa, sacola...), com custo congelado. */
  packagingItems?: OrderPackagingSnapshot[];
  /** Valor congelado efetivamente cobrado pelas embalagens adicionais; ausente em pedidos antigos significa zero. */
  packagingCharge?: number;
  /** Código permanente de atendimento (ex.: ORC-K7M42P). Gerado na criação e nunca muda. Ausente só em encomendas antigas, que recebem um código derivado do id. */
  quoteCode?: string;
  /** Recebimentos posteriores ao sinal (`deposit`). Ausente = nenhum. */
  payments?: Payment[] };
export type Settings = {
  cupSizeMl: number;
  /** Dados do negócio, usados nos orçamentos compartilhados. */
  businessName?: string;
  /** Somente dígitos, com DDI/DDD (ex.: 5541999990000). */
  businessPhone?: string;
  /** Minutos de produção disponíveis por dia de trabalho. */
  dailyCapacityMinutes?: number;
  /** Dias de trabalho (0 = domingo … 6 = sábado). Padrão: segunda a sábado. */
  workWeekdays?: number[];
};
/**
 * Versão 2: encomendas podem ter `costSnapshot` (versão 1, sem snapshot, é migrada sem inventar custos históricos).
 * Versão 3: encomendas podem ter `payments` (sem mudança nos dados existentes: o sinal continua em `deposit`).
 * Versão 4: embalagens. Versão 5: encomendas têm `items` (várias receitas); as antigas viram um item, sem inventar dados.
 */
export const CURRENT_SCHEMA_VERSION = 5;
export type DataSet = { schemaVersion: 5; ingredients: Ingredient[]; recipes: Recipe[]; orders: Order[]; packagings: Packaging[]; settings?: Settings };
