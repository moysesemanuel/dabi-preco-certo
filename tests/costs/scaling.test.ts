import { describe, expect, it } from 'vitest';
import { Device } from '../helpers/device';
import { makeServer } from '../helpers/server';
import { dataset } from './profile';

/** Quanto custa UMA edição sincronizada e UMA sincronização sem mudanças conforme a conta cresce? (estimativa local de linhas lidas) */
async function costs(records: number) {
  const s = makeServer(undefined, { meter: true }); await s.issueFor('bia@exemplo.com');
  const A = new Device(s, await s.login('bia@exemplo.com', 'A', '10.0.0.1'));
  A.edit(() => dataset(Math.round(records * 0.5), Math.round(records * 0.17), Math.round(records * 0.33))); await A.sync();
  A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'i3' ? { ...i, purchasePrice: 99 } : i)) }));
  s.meter!.reset(); await A.sync(); const edit = s.meter!.snapshot();
  s.meter!.reset(); await A.sync(); const idle = s.meter!.snapshot();
  return { edit, idle };
}

describe('O custo de uma operação não cresce com o tamanho da conta', () => {
  it('sincronização SEM mudanças lê o mesmo número de linhas com 60 ou 1.500 registros (a API devolve só o que mudou)', async () => {
    const small = await costs(60), big = await costs(1500);
    expect(big.idle.rowsRead).toBe(small.idle.rowsRead); expect(big.idle.queries).toBe(small.idle.queries);
  }, 60_000);
  it('editar 1 registro lê aproximadamente o mesmo com 60 ou 1.500 registros (não relê a conta inteira para validar referências)', async () => {
    const small = await costs(60), big = await costs(1500);
    expect(big.edit.rowsRead).toBeLessThanOrEqual(small.edit.rowsRead + 5);
  }, 60_000);
});
