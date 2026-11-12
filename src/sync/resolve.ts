/**
 * Decisão do usuário sobre um conflito de dados (comparação "neste dispositivo" × "na nuvem").
 *  - keep-local: mantém a versão daqui. A versão da nuvem vira a nova base (com a revisão dela), então o próximo envio usa essa revisão:
 *    se a nuvem mudou de novo, o servidor recusa, o pull atualiza o conflito e pede nova decisão (nada é sobrescrito em silêncio).
 *  - keep-server: aplica a versão da nuvem. A versão local continua guardada no registro (histórico) até o usuário dispensá-lo.
 * Funções puras: devolvem os novos dados e o novo meta; lançam Error com a explicação quando a regra impede.
 */
import { orderTotal, totalReceived } from '../domain/payments';
import { toCents2 } from '../domain/money';
import type { DataSet, Order, Payment } from '../domain/types';
import type { RevMap } from '../../shared/sync';
import { findDanglingRefs, isPendingConflict, type ConflictRecord, type SyncMeta } from './engine';

export type ConflictAction = 'keep-local' | 'keep-server';

type Key = 'ingredients' | 'recipes' | 'orders';
const swap = <T extends { id: string }>(list: T[], id: string, next: T | null): T[] => {
  const has = list.some(x => x.id === id);
  if (next === null) return list.filter(x => x.id !== id);
  return has ? list.map(x => (x.id === id ? next : x)) : [...list, next];
};

/** Encomenda: ao manter a versão local, os recebimentos que existem na nuvem NUNCA são descartados (pagamentos não são um campo substituível). */
function keepLocalOrder(local: Order, server: Order | null, base: Order | null): Order {
  if (!server) return local;
  const byId = new Map<string, Payment>();
  for (const p of server.payments ?? []) byId.set(p.id, p);
  for (const p of local.payments ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
  const payments = [...byId.values()];
  const next: Order = { ...local, deposit: local.deposit !== (base?.deposit ?? 0) ? local.deposit : server.deposit, ...(payments.length ? { payments } : {}) };
  if (!payments.length) delete next.payments;
  if (toCents2(totalReceived(next)) > orderTotal(next) + 0.005) throw new Error('Manter a sua versão faria os recebimentos passarem do total da encomenda. Ajuste os recebimentos e tente de novo.');
  return next;
}

export function resolveConflict(data: DataSet, meta: SyncMeta, conflictId: string, action: ConflictAction, now: Date, expectedServerRev?: number): { data: DataSet; meta: SyncMeta; conflict: ConflictRecord } {
  const c = meta.conflicts.find(x => x.id === conflictId);
  if (!c || !isPendingConflict(c)) throw new Error('Este conflito já foi resolvido ou não existe mais.');
  if (expectedServerRev !== undefined && c.serverRev !== expectedServerRev) throw new Error('A versão da nuvem mudou enquanto você decidia. Revise a comparação e escolha de novo.');
  const resolved: ConflictRecord = { ...c, pending: false, resolution: { action, at: now.toISOString() } };
  const revs = structuredClone(meta.revs), baseline = structuredClone(meta.baseline);
  let next = data;

  if (c.kind === 'settings') {
    if (action === 'keep-server' && c.server) next = { ...data, settings: c.server as DataSet['settings'] };
    if (c.server) baseline.settings = c.server as DataSet['settings'];
    if (c.serverRev !== undefined) revs.settings = c.serverRev;
  } else {
    const k = c.kind as Key;
    let value = (action === 'keep-server' ? c.server : (data[k] as { id: string }[]).find(x => x.id === c.entityId) ?? null) as ({ id: string } | null);
    if (action === 'keep-local' && k === 'orders' && value) value = keepLocalOrder(value as Order, c.server as Order | null, c.base as Order | null);
    if (action === 'keep-local' && value === null && c.server === null) value = null; // já excluído dos dois lados
    next = { ...data, [k]: swap(data[k] as { id: string }[], c.entityId, value) } as DataSet;
    if (action === 'keep-server') {
      const before = findDanglingRefs(data).length, after = findDanglingRefs(next);
      if (after.length > before) throw new Error(`Não é possível aplicar a versão da nuvem: ${after[0]} Resolva isso antes.`);
    }
    // A versão da nuvem passa a ser a base conhecida (e a revisão dela), inclusive a revisão da exclusão lógica.
    const list = baseline[k] as { id: string }[];
    (baseline as unknown as Record<Key, { id: string }[]>)[k] = swap(list, c.entityId, (c.server as { id: string } | null) ?? null);
    if (c.serverRev !== undefined) (revs[k] as RevMap)[c.entityId] = c.serverRev;
  }
  return { data: next, meta: { ...meta, revs, baseline, conflicts: meta.conflicts.map(x => (x.id === c.id ? resolved : x)) }, conflict: resolved };
}
