import type { Page } from './utils';

export type AppRoute = { page: Page; orderId?: string };

export function routeFromPath(pathname: string): AppRoute {
  if (pathname === '/encomendas') return { page: 'orders' }; // URL legada: mantinha lista e gestão
  if (pathname === '/encomendas/nova') return { page: 'new-order' };
  if (pathname === '/pedidos') return { page: 'orders' };
  const detail = /^\/pedidos\/([^/]+)$/.exec(pathname);
  if (detail) {
    try { return { page: 'order-detail', orderId: decodeURIComponent(detail[1]) }; } catch { return { page: 'orders' }; }
  }
  const routes: Record<string, Page> = {
    '/': 'dashboard', '/ingredientes': 'ingredients', '/embalagens': 'packagings', '/receitas': 'recipes',
    '/agenda': 'agenda', '/conversor': 'converter', '/configuracoes': 'settings', '/backup': 'backup',
  };
  return { page: routes[pathname] ?? 'dashboard' };
}

export function pathForRoute(route: AppRoute): string {
  if (route.page === 'order-detail') return route.orderId ? `/pedidos/${encodeURIComponent(route.orderId)}` : '/pedidos';
  const paths: Record<Exclude<Page, 'order-detail'>, string> = {
    dashboard: '/', ingredients: '/ingredientes', packagings: '/embalagens', recipes: '/receitas',
    'new-order': '/encomendas/nova', orders: '/pedidos', agenda: '/agenda', converter: '/conversor', settings: '/configuracoes', backup: '/backup',
  };
  return paths[route.page];
}
