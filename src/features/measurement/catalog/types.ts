/**
 * Catálogo de equivalências culinárias. Três tipos de equivalência, nunca misturados:
 *  - volume → peso: `kind: 'volume'` (peso de uma medida de VOLUME conhecida; a densidade sai de gramas ÷ volume de referência);
 *  - unidade → peso: `kind: 'unit'` (peso de UMA unidade, ex.: um ovo grande);
 *  - massa ↔ massa e volume ↔ volume não dependem do catálogo (são exatas).
 * Cada apresentação (peneirado, compactado, cru, cozido…) é uma variante própria, com a sua fonte.
 */
export type VolumeMeasure = {
  kind: 'volume';
  /** Medida usada pela fonte: xícara/colher de sopa/colher de chá americanas (definições exatas do NIST) ou mL. */
  unit: 'cup' | 'tbsp' | 'tsp' | 'ml';
  /** Volume real (mL) da medida da fonte. A xícara americana é 236,588 mL, NÃO 240 mL. */
  refVolumeMl: number;
  grams: number;
  /** Descrição da porção exatamente como publicada pela fonte. */
  usda: string;
};
export type UnitMeasure = { kind: 'unit'; label: string; grams: number; usda: string };
export type CatalogMeasure = VolumeMeasure | UnitMeasure;
export type CatalogSource = { fdcId: number; ndb: number; description: string };
export type CatalogVariant = {
  id: string;
  /** Apresentação em português ("Peneirado", "Cru"…). */
  label: string;
  /** Apresentação sugerida quando o usuário não escolhe outra. */
  default?: true;
  note?: string;
  source: CatalogSource;
  measures: CatalogMeasure[];
};
export type CatalogItem = { id: string; name: string; category: string; synonyms: string[]; variants: CatalogVariant[] };
