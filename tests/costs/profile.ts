import type { DataSet, Order } from '../../src/domain/types';
import { buildPublicQuote, createQuotesClient } from '../../src/features/sharing/quotes';
import { emptyDataSet } from '../../src/sync/engine';
import { uniqueQuoteCode } from '../../shared/quoteCode';
import type { Usage } from '../helpers/costMeter';
import { Device } from '../helpers/device';
import { makeServer, type Server } from '../helpers/server';

/** Perfil de consumo medido localmente: cada ação típica do app contra o Worker REAL e SQLite REAL (com as migrações reais). */
export type Measured = Usage & { name: string };
const diff = (name: string, s: Server, run: () => Promise<unknown>): Promise<Measured> => (async () => {
  s.meter!.reset(); await run(); return { name, ...s.meter!.snapshot() };
})();

export const dataset = (ingredients = 30, recipes = 10, orders = 20): DataSet => {
  const d = emptyDataSet(); const used = new Set<string>();
  d.ingredients = Array.from({ length: ingredients }, (_, i) => ({ id: `i${i}`, name: `Ingrediente ${i}`, unit: 'g' as const, purchaseQuantity: 1000, purchasePrice: 5 + i }));
  d.recipes = Array.from({ length: recipes }, (_, r) => ({ id: `r${r}`, name: `Receita ${r}`, yield: 10, items: [0, 1, 2].map(k => ({ ingredientId: `i${(r + k) % ingredients}`, quantity: 100, unit: 'g' as const })), packagingPerUnit: 1, laborTotal: 10, extraTotal: 2, desiredMargin: 30 }));
  d.orders = Array.from({ length: orders }, (_, o): Order => ({ id: `o${o}`, quoteCode: uniqueQuoteCode(used), customer: `Cliente ${o}`, recipeId: `r${o % recipes}`, quantity: 2, unitPrice: 40, deposit: 10, deliveryDate: '2026-12-01', status: 'Confirmado', createdAt: '2026-11-11T10:00:00.000Z', payments: o % 3 === 0 ? [{ id: `p${o}`, amount: 20, receivedAt: '2026-11-12' }] : undefined }));
  return d;
};

export async function measureProfile(opts: { ingredients?: number; recipes?: number; orders?: number } = {}): Promise<Measured[]> {
  const s = makeServer(undefined, { meter: true }); await s.issueFor('bia@exemplo.com'); await s.issueFor('carla@exemplo.com');
  const out: Measured[] = [];
  out.push(await diff('Login: pedir código + confirmar (2 requisições)', s, async () => {
    await s.request('POST', '/api/auth/request-code', { body: { email: 'carla@exemplo.com' } });
    await s.request('POST', '/api/auth/verify-code', { body: { email: 'carla@exemplo.com', code: s.mail.lastCode(), deviceLabel: 'Celular' } });
  }));
  const sA = await s.login('bia@exemplo.com', 'Notebook', '10.0.0.9'), sB = await s.login('bia@exemplo.com', 'Outro', '10.0.0.6');
  const A = new Device(s, sA);
  out.push(await diff('Abrir o app já logado: GET /api/auth/session', s, async () => { await s.request('GET', '/api/auth/session', { session: sA }); }));
  A.edit(() => dataset(opts.ingredients, opts.recipes, opts.orders));
  out.push(await diff(`Primeira sincronização (envia ${(opts.ingredients ?? 30) + (opts.recipes ?? 10) + (opts.orders ?? 20)} registros)`, s, () => A.sync()));
  out.push(await diff('Sincronização sem mudanças (ao voltar o foco / abrir)', s, () => A.sync()));
  A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'i3' ? { ...i, purchasePrice: 99 } : i)) }));
  out.push(await diff('Editar 1 ingrediente e sincronizar (pull + push + pull)', s, () => A.sync()));
  A.edit(d => ({ ...d, orders: d.orders.map(o => (o.id === 'o1' ? { ...o, status: 'Entregue' as const, payments: [...(o.payments ?? []), { id: 'pz', amount: 15, receivedAt: '2026-11-13' }] } : o)) }));
  out.push(await diff('Registrar um recebimento e sincronizar', s, () => A.sync()));
  const B = new Device(s, sB);
  s.meter!.reset(); await B.sync(); // B baixa tudo
  out.push({ name: `Outro aparelho baixa a conta inteira (${(opts.ingredients ?? 30) + (opts.recipes ?? 10) + (opts.orders ?? 20)} registros)`, ...s.meter!.snapshot() });
  A.edit(d => ({ ...d, ingredients: d.ingredients.map(i => (i.id === 'i4' ? { ...i, purchasePrice: 77 } : i)) })); await A.sync();
  out.push(await diff('Outro aparelho recebe 1 mudança', s, () => B.sync()));

  const sess = sA;
  const client = createQuotesClient('https://api.exemplo.test', () => sess.csrf, s.fetchFor(sess));
  const built = buildPublicQuote({ ...A.data.orders[0] }, A.data.recipes[0], { cupSizeMl: 240, businessName: 'Doces da Bia' }, { issuedAt: '2026-11-12', validUntil: '2026-11-19' });
  if (!built.ok) throw new Error(built.error);
  let pubId = '';
  out.push(await diff('Publicar link de orçamento', s, async () => { const r = await client.publish(built.quote); if (r.ok) pubId = r.value.id; }));
  out.push(await diff('Cliente abre o link público (GET /o/:id)', s, async () => { await s.request('GET', `/o/${pubId}`); }));
  out.push(await diff('Listar links publicados (Configurações)', s, () => client.list()));
  out.push(await diff('Revogar link', s, () => client.revoke(pubId)));
  return out;
}

/** Armazenamento do D1 por conta: cresce o banco com uma conta grande e mede páginas × tamanho da página (inclui índices). */
export async function measureStorage(records = 600): Promise<{ records: number; bytesPerAccount: number; bytesPerRecord: number }> {
  const s = makeServer(undefined, { meter: true }); await s.issueFor('bia@exemplo.com');
  const size = () => { const r = s.db.raw.prepare('PRAGMA page_count').get() as { page_count: number }; const p = s.db.raw.prepare('PRAGMA page_size').get() as { page_size: number }; return r.page_count * p.page_size; };
  const baseline = size();
  const A = new Device(s, await s.login('bia@exemplo.com', 'A', '10.0.0.1'));
  A.edit(() => dataset(Math.round(records * 0.5), Math.round(records * 0.17), Math.round(records * 0.33)));
  await A.sync();
  const total = size() - baseline, n = A.data.ingredients.length + A.data.recipes.length + A.data.orders.length;
  return { records: n, bytesPerAccount: total / (n / 60), bytesPerRecord: total / n }; // por conta típica (60 registros)
}
