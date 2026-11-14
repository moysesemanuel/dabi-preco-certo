import { DEFAULT_CUP_ML } from '../features/measurement/convert';
import { recipeCost } from './pricing';
import type { DataSet, Recipe } from './types';

export type CostChange = { recipeId: string; name: string; before?: number; after?: number };

const costOf = (d: DataSet, r: Recipe): number | undefined => { try { return recipeCost(r, d.ingredients, d.settings?.cupSizeMl ?? DEFAULT_CUP_ML, d.packagings ?? []).costPerUnit; } catch { return undefined; } };

/**
 * Receitas cujo custo por unidade muda (ou deixa de ser calculável) entre dois estados dos dados. Serve para avisar quando uma
 * equivalência nova altera um cálculo. Só leitura: nada é regravado; encomendas e custos históricos (`costSnapshot`) não entram aqui.
 */
export function costImpact(before: DataSet, after: DataSet): CostChange[] {
  const out: CostChange[] = [];
  for (const r of after.recipes) {
    const prev = before.recipes.find(x => x.id === r.id) ?? r;
    const b = costOf(before, prev), a = costOf(after, r);
    if (b === undefined && a === undefined) continue;
    if (b === undefined || a === undefined || Math.abs(a - b) >= 0.005) out.push({ recipeId: r.id, name: r.name, before: b, after: a });
  }
  return out;
}
