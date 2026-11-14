// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorage } from './setup';

const BASE = 'https://api.exemplo.test';
const SESSION = { user: { id: 'usr_1', email: 'bia@exemplo.com' }, csrfToken: 'csrf-de-teste', sessionId: 'ses_aaaaaaaaaaaaaaaa', license: { status: 'active', quotaActive: 100, quotaDaily: 30 } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Server = { otherUser: boolean; logout: 'ok' | 'network' | 'error' | 'expired'; signedIn: boolean; deviceLimit: boolean; offline: boolean; calls: { method: string; path: string; body?: unknown }[] };
function fakeServer(): Server {
  const s: Server = { otherUser: false, logout: 'ok', signedIn: false, deviceLimit: false, offline: false, calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (s.offline) throw new TypeError('Failed to fetch');
    const path = url.replace(BASE, ''); const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    s.calls.push({ method, path, body });
    if (s.otherUser && path === '/api/sync/v2/push') return json(403, { error: 'CSRF' }); // outra aba entrou com OUTRA conta: o token desta aba não vale
    if (s.otherUser && path === '/api/auth/session') return json(200, { ...SESSION, user: { id: 'usr_2', email: 'caio@exemplo.com' }, csrfToken: 'csrf-do-caio' });
    if (path === '/api/auth/session') return s.signedIn ? json(200, SESSION) : json(401, { error: 'UNAUTHORIZED' });
    if (path === '/api/auth/request-code') return json(202, { ok: true, expiresInMinutes: 10 });
    if (path === '/api/auth/verify-code') {
      if (body.code === '00000000') return json(401, { error: 'INVALID_CODE' });
      if (s.deviceLimit && !body.replaceSessionId) return json(409, { error: 'DEVICE_LIMIT', sessions: [{ id: 'ses_bbbbbbbbbbbbbbbb', deviceLabel: 'Celular antigo', createdAt: '2026-11-01T10:00:00Z', lastSeenAt: '2026-11-10T10:00:00Z' }] });
      s.signedIn = true; return json(200, SESSION);
    }
    if (path === '/api/auth/logout') {
      if (s.logout === 'network') throw new TypeError('Failed to fetch');
      if (s.logout === 'error') return json(500, { error: 'INTERNAL' });
      s.signedIn = false; return s.logout === 'expired' ? json(401, { error: 'UNAUTHORIZED' }) : json(200, { ok: true });
    }
    if (path === '/api/sessions') return json(200, { maxSessions: 2, sessions: [{ id: SESSION.sessionId, deviceLabel: 'Mac (navegador)', createdAt: '2026-11-11T10:00:00Z', lastSeenAt: '2026-11-11T10:00:00Z', current: true }] });
    if (path.startsWith('/api/sync/v2?')) return json(200, { protocol: 2, revision: 0, ingredients: [], recipes: [], orders: [] });
    if (path === '/api/sync/v2/push') return json(200, { revision: 1, changed: true });
    if (path === '/api/quotes') return json(200, { quotes: [] });
    return json(404, {});
  }));
  return s;
}

async function boot(api: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', api ?? '');
  vi.stubEnv('VITE_QUOTES_API_URL', '');
  const { default: App } = await import('../../src/App');
  render(<App />);
  await waitFor(() => expect(screen.queryByText('Carregando seus dados…')).toBeNull());
}
const nav = async (u: ReturnType<typeof userEvent.setup>, name: string) => { await u.click(within(screen.getByRole('navigation', { name: 'Navegação principal' })).getByRole('button', { name })); };

async function signIn(u: ReturnType<typeof userEvent.setup>, code = '12345678') {
  await nav(u, 'Configurações');
  await u.type(await screen.findByLabelText('E-mail da compra'), 'bia@exemplo.com');
  await u.click(screen.getByRole('button', { name: 'Enviar código de acesso' }));
  await u.type(await screen.findByLabelText('Código de 8 dígitos'), code);
  await u.click(screen.getByRole('button', { name: 'Entrar' }));
}

beforeEach(async () => { await resetStorage(); vi.stubGlobal('confirm', () => true); });

describe('Sem serviço configurado', () => {
  it('explica que a conta não está disponível e o app continua funcionando', async () => {
    const u = userEvent.setup();
    await boot(undefined);
    await nav(u, 'Configurações');
    expect(screen.getAllByText(/serviço online não está configurado/).length).toBeGreaterThan(0);
    expect(screen.getByRole('status', { name: '' }) ).toBeTruthy();
    await nav(u, 'Ingredientes');
    expect(screen.getByLabelText('Nome do ingrediente')).toBeTruthy();
  });
});

describe('Entrar na conta', () => {
  it('pede o código, rejeita um código errado com mensagem clara e entra com o certo', async () => {
    const u = userEvent.setup(); const server = fakeServer();
    await boot(BASE);
    await signIn(u, '00000000');
    expect((await screen.findByRole('alert')).textContent).toContain('Código inválido ou expirado');
    expect(screen.queryByText(/Conectado como/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Código de 8 dígitos'), { target: { value: '12345678' } });
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('bia@exemplo.com', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Mac (navegador)')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/Sincronizado/).length).toBeGreaterThan(0));
    expect(server.calls.some(c => c.path === '/api/auth/request-code' && (c.body as { email: string }).email === 'bia@exemplo.com')).toBe(true);
    expect(server.calls.some(c => c.path.startsWith('/api/sync/v2?since=0'))).toBe(true);
  });

  it('com 2 dispositivos já ativos, mostra a escolha e troca um deles usando o mesmo código', async () => {
    const u = userEvent.setup(); const server = fakeServer(); server.deviceLimit = true;
    await boot(BASE);
    await signIn(u);
    expect(await screen.findByText(/já está em 2 dispositivos/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /Desconectar "Celular antigo"/ }));
    expect(await screen.findByText(/Conectado como/)).toBeTruthy();
    const verifies = server.calls.filter(c => c.path === '/api/auth/verify-code');
    expect(verifies).toHaveLength(2);
    expect(verifies[1].body).toMatchObject({ code: '12345678', replaceSessionId: 'ses_bbbbbbbbbbbbbbbb' });
  });

  it('o cookie de sessão é usado automaticamente: ao abrir o app já aparece como conectado', async () => {
    const server = fakeServer(); server.signedIn = true;
    const u = userEvent.setup();
    await boot(BASE);
    await nav(u, 'Configurações');
    expect(await screen.findByText(/Conectado como/)).toBeTruthy();
    expect(screen.getAllByText(/bia@exemplo.com/).length).toBeGreaterThan(0); // também no topo da tela
  });

  it('sair da conta mantém os dados deste dispositivo', async () => {
    const u = userEvent.setup(); fakeServer();
    await boot(BASE);
    await nav(u, 'Ingredientes');
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Farinha');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '6' } });
    await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
    await signIn(u);
    await screen.findByText(/Conectado como/);
    await u.click(screen.getByRole('button', { name: /Sair desta conta/ }));
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    await nav(u, 'Ingredientes');
    expect(screen.getByText('Farinha')).toBeTruthy();
  });
});

describe('Logout só é confirmado quando o servidor confirma', () => {
  async function ready() { const u = userEvent.setup(); const server = fakeServer(); await boot(BASE); await signIn(u); await screen.findByText(/Conectado como/); return { u, server }; }
  it('falha de rede: continua conectado, avisa com clareza e NÃO diz que saiu', async () => {
    const { u, server } = await ready(); server.logout = 'network';
    await u.click(screen.getByRole('button', { name: /Sair desta conta/ }));
    expect(await screen.findByText(/Você continua conectado/)).toBeTruthy();
    expect(screen.queryByText(/Você saiu desta conta/)).toBeNull();
    expect(screen.getByText(/Conectado como/)).toBeTruthy();
    // ao voltar a rede, tentar de novo funciona
    server.logout = 'ok';
    await u.click(screen.getByRole('button', { name: /Sair desta conta/ }));
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
  });
  it('erro do servidor (500): continua conectado e não confirma a saída', async () => {
    const { u, server } = await ready(); server.logout = 'error';
    await u.click(screen.getByRole('button', { name: /Sair desta conta/ }));
    expect(await screen.findByText(/Você continua conectado/)).toBeTruthy();
    expect(screen.queryByText(/Você saiu desta conta/)).toBeNull();
  });
  it('sessão já expirada (401): a saída vale, pois a sessão já não existe no servidor', async () => {
    const { u, server } = await ready(); server.logout = 'expired';
    await u.click(screen.getByRole('button', { name: /Sair desta conta/ }));
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
  });
});

describe('Troca de conta em outra aba', () => {
  it('uma aba com a sessão antiga NÃO assume em silêncio a identidade da outra conta nem envia dados', async () => {
    const u = userEvent.setup(); const server = fakeServer(); server.signedIn = true;
    await boot(BASE); await nav(u, 'Configurações'); await screen.findByText(/Conectado como/);
    server.otherUser = true; // outra aba saiu e entrou como outra pessoa
    await nav(u, 'Ingredientes');
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Farinha');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '6' } });
    await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
    await waitFor(() => expect(server.calls.some(c => c.path === '/api/sync/v2/push')).toBe(true), { timeout: 8000 });
    await nav(u, 'Configurações');
    expect(await screen.findByRole('heading', { name: 'Entrar na conta' })).toBeTruthy();
    expect(screen.queryByText(/caio@exemplo.com/)).toBeNull();
    expect(screen.getByText(/A conta usada neste navegador mudou em outra aba/)).toBeTruthy();
    await nav(u, 'Ingredientes'); expect(screen.getByText('Farinha')).toBeTruthy(); // dados locais preservados
  }, 20000);
});

describe('Sincronização na interface', () => {
  it('envia os dados locais depois de entrar', async () => {
    const u = userEvent.setup(); const server = fakeServer();
    await boot(BASE);
    await nav(u, 'Ingredientes');
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Farinha');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '6' } });
    await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
    await signIn(u);
    await waitFor(() => expect(server.calls.some(c => c.path === '/api/sync/v2/push')).toBe(true));
    const push = server.calls.find(c => c.path === '/api/sync/v2/push')!.body as { upserts: { ingredients: { name: string; purchasePrice: number }[] } };
    expect(push.upserts.ingredients).toMatchObject([{ name: 'Farinha', purchasePrice: 6 }]);
  });

  it('sem internet: avisa, mantém as alterações locais e não perde nada', async () => {
    const u = userEvent.setup(); const server = fakeServer(); server.signedIn = true;
    await boot(BASE);
    await nav(u, 'Configurações');
    await screen.findByText(/Conectado como/);
    server.offline = true;
    await nav(u, 'Ingredientes');
    await u.type(screen.getByLabelText('Nome do ingrediente'), 'Açúcar');
    fireEvent.change(screen.getByLabelText('Preço pago (R$)'), { target: { value: '5' } });
    await u.click(screen.getByRole('button', { name: /Adicionar ingrediente/ }));
    expect(await screen.findByText('Ingrediente cadastrado.')).toBeTruthy();
    expect(screen.getByText('Açúcar')).toBeTruthy(); // continua usável offline
    await waitFor(() => expect(screen.getByRole('button', { name: /Sincronização: (Sem conexão|Servidor inacessível)/ })).toBeTruthy(), { timeout: 6000 }); // o indicador do cabeçalho descreve o estado no tooltip/rótulo acessível
  }, 15000);

  it('a mensagem do servidor para licença revogada não derruba nada', async () => {
    const server = fakeServer(); server.signedIn = true;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => (String(url).endsWith('/api/auth/session') ? json(200, { ...SESSION, license: { status: 'revoked', quotaActive: 1, quotaDaily: 1 } }) : json(404, {})));
    const u = userEvent.setup();
    await boot(BASE);
    await nav(u, 'Configurações');
    expect(await screen.findByText(/licença desta conta foi revogada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sincronizar agora/ })).toBeNull();
  });
});
