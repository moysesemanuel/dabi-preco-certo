import { describe, expect, it } from 'vitest';
import { pathForRoute, routeFromPath } from '../src/appRoutes';

describe('rotas internas do Custô', () => {
  it('abre cadastro, lista e detalhes por URLs recarregáveis', () => {
    expect(routeFromPath('/encomendas/nova')).toEqual({ page: 'new-order' });
    expect(routeFromPath('/pedidos')).toEqual({ page: 'orders' });
    expect(routeFromPath('/pedidos/order%2F123')).toEqual({ page: 'order-detail', orderId: 'order/123' });
    expect(pathForRoute({ page: 'order-detail', orderId: 'order/123' })).toBe('/pedidos/order%2F123');
  });
  it('mantém /encomendas como atalho compatível para Pedidos', () => {
    expect(routeFromPath('/encomendas')).toEqual({ page: 'orders' });
  });
  it('não captura rotas públicas nem APIs como páginas do app', () => {
    expect(routeFromPath('/o/ORC-X1')).toEqual({ page: 'dashboard' });
    expect(routeFromPath('/api/orders')).toEqual({ page: 'dashboard' });
  });
});
