import { describe, expect, it } from 'vitest';
import { filterOrders } from '../src/domain/orderSearch';
import type { Order } from '../src/domain/types';

const mk = (id: string, customer: string, status: Order['status'], recipeId: string): Order => ({ id, customer, recipeId, quantity: 1, unitPrice: 10, deposit: 0, deliveryDate: '2026-12-01', status, createdAt: '2026-11-11T10:00:00.000Z' });
const orders = [mk('uuid-aaaa-1111', 'Ana Martins', 'Orçamento', 'bolo'), mk('uuid-bbbb-2222', 'José Conceição', 'Confirmado', 'brig'), mk('uuid-cccc-3333', 'Maria Antônia', 'Entregue', 'bolo')];
const codes = new Map([['uuid-aaaa-1111', 'ORC-K7M42P'], ['uuid-bbbb-2222', 'ORC-X9T3QW'], ['uuid-cccc-3333', 'ORC-K7N8RB']]);
const products: Record<string, string> = { bolo: 'Bolo de Cenoura', brig: 'Brigadeiro Gourmet' };
const ctx = { codes, productOf: (o: Order) => products[o.recipeId] };
const ids = (q: string) => filterOrders(orders, q, ctx).map(o => o.id);

describe('Busca de pedidos', () => {
  it('sem texto devolve todos', () => { expect(ids('')).toHaveLength(3); expect(ids('   ')).toHaveLength(3); });
  it('por código: completo, sem prefixo, sem hífen, parcial e em qualquer caixa', () => {
    for (const q of ['ORC-K7M42P', 'orc-k7m42p', 'ORCK7M42P', 'K7M42P', 'k7m42p', 'k7m4', 'ORC K7M42P']) expect(ids(q), q).toEqual(['uuid-aaaa-1111']);
    expect(ids('k7')).toEqual(['uuid-aaaa-1111', 'uuid-cccc-3333']);
    expect(ids('orc')).toHaveLength(3); // todos os códigos começam com ORC
  });
  it('por cliente, sem acento e sem diferenciar caixa', () => {
    expect(ids('jose')).toEqual(['uuid-bbbb-2222']); expect(ids('CONCEICAO')).toEqual(['uuid-bbbb-2222']); expect(ids('antonia')).toEqual(['uuid-cccc-3333']); expect(ids('martins ana')).toEqual(['uuid-aaaa-1111']);
  });
  it('por produto (receita) e por status', () => {
    expect(ids('cenoura')).toEqual(['uuid-aaaa-1111', 'uuid-cccc-3333']); expect(ids('BRIGADEIRO')).toEqual(['uuid-bbbb-2222']);
    expect(ids('confirmado')).toEqual(['uuid-bbbb-2222']); expect(ids('orcamento')).toEqual(['uuid-aaaa-1111']); expect(ids('entregue')).toEqual(['uuid-cccc-3333']);
  });
  it('várias palavras combinam campos diferentes (todas precisam aparecer)', () => {
    expect(ids('maria cenoura')).toEqual(['uuid-cccc-3333']); expect(ids('ana brigadeiro')).toEqual([]);
    expect(ids('cenoura entregue')).toEqual(['uuid-cccc-3333']);
  });
  it('NÃO pesquisa identificadores internos nem valores', () => {
    expect(ids('uuid')).toEqual([]); expect(ids('aaaa-1111')).toEqual([]); expect(ids('aaaa')).toEqual([]); expect(ids('1111')).toEqual([]);
  });
  it('sem resultados devolve lista vazia; não altera a lista original', () => {
    expect(ids('zzzz')).toEqual([]); expect(orders).toHaveLength(3);
  });
});
