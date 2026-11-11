import { recipeCost } from './domain/pricing';
import type { DataSet, Recipe, Unit } from './domain/types';
import { DEFAULT_CUP_ML } from './features/measurement/convert';

export type Page = 'dashboard' | 'ingredients' | 'recipes' | 'orders' | 'converter' | 'backup';
export type PageProps = {
  data: DataSet;
  update: (fn: (prev: DataSet) => DataSet) => void;
  inform: (msg: string) => void;
  focus: (page: Page) => void;
};

export const newId = () => crypto.randomUUID();
export const parse = (v: string) => Number(v.replace(',', '.'));
export const units: Unit[] = ['g', 'kg', 'ml', 'l', 'un'];
export const brDate = (iso: string) => iso.split('-').reverse().join('/');
export const cupSizeOf = (d: DataSet) => d.settings?.cupSizeMl ?? DEFAULT_CUP_ML;
export type Priced = { ok: true; cost: ReturnType<typeof recipeCost> } | { ok: false; message: string };
/** Calcula o custo da receita. Em caso de falha devolve a mensagem; nunca assume custo zero. */
export function priceRecipe(r: Recipe, d: DataSet): Priced {
  try { return { ok: true, cost: recipeCost(r, d.ingredients, cupSizeOf(d)) }; }
  catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'Não foi possível calcular o custo.' }; }
}
