// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminApp from '../../src/admin/AdminApp';
import { BASE, makeServer, type Server, type Session } from '../helpers/server';

// A tela contra o Worker REAL (SQLite com as migrações reais): o navegador é simulado por um fetch que entrega as requisições ao Worker levando o cookie.
let srv: Server; let owner: Session; let ana: Session; let flaky: { network: boolean; path?: RegExp };
const grant = (email: string) => { const u = srv.db.raw.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string }; srv.db.raw.prepare("INSERT INTO admins (user_id, role, granted_at, granted_by) VALUES (?, 'owner', 'x', 'cli')").run(u.id); };
const useBrowser = (s: Session) => { const real = srv.fetchFor(s); vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (flaky.network && (!flaky.path || flaky.path.test(url))) throw new TypeError('Failed to fetch'); return real(url, init); })); };
const open = () => render(<AdminApp apiBase={BASE} />);
const lic = (email: string) => (srv.db.raw.prepare('SELECT id, status FROM licenses WHERE email = ?').get(email) as { id: string; status: string });

beforeEach(async () => {
  flaky = { network: false }; srv = makeServer();
  await srv.issueFor('dono@exemplo.com'); await srv.issueFor('ana@exemplo.com'); await srv.issueFor('bruno@exemplo.com');
  owner = await srv.login('dono@exemplo.com', 'Notebook', '10.0.0.1'); ana = await srv.login('ana@exemplo.com', 'Celular da Ana', '10.0.0.2'); grant('dono@exemplo.com'); useBrowser(owner);
});
afterEach(cleanup);

describe('Painel /admin', () => {
  it('cliente comum: vê "Acesso negado" e nenhuma função administrativa (a permissão é do servidor)', async () => {
    useBrowser(ana); open();
    expect(await screen.findByText(/Acesso negado/)).toBeTruthy(); expect(screen.queryByRole('button', { name: /Cadastrar cliente/ })).toBeNull(); expect(screen.queryByRole('navigation', { name: 'Navegação administrativa' })).toBeNull();
  });
  it('sem sessão: pede login (nada administrativo é carregado)', async () => {
    vi.stubGlobal('fetch', srv.fetchFor(undefined)); open();
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy(); expect(screen.getByLabelText('E-mail do administrador')).toBeTruthy();
  });
  it('visão geral com números reais', async () => {
    open(); await screen.findByRole('heading', { name: 'Visão geral' });
    const card = (label: string) => screen.findByText(label).then(e => e.closest('.metric-card') as HTMLElement);
    expect((await card('Clientes cadastrados')).textContent).toContain('3'); expect((await card('Licença ativa')).textContent).toContain('3'); expect((await card('Sessões ativas')).textContent).toContain('2');
    expect(screen.getByText(/não há métricas financeiras/i)).toBeTruthy();
  });
  it('cadastra cliente (sem enviar e-mail), mostra os detalhes e é idempotente', async () => {
    const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: /^Clientes$/ }));
    await u.click(await screen.findByRole('button', { name: /Cadastrar cliente/ })); await u.type(screen.getByLabelText('E-mail do cliente'), 'Nova@Exemplo.com'); await u.type(screen.getByLabelText(/Rótulo/), 'Doces da Nova');
    await u.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByRole('heading', { name: 'nova@exemplo.com' })).toBeTruthy(); expect(screen.getByText(/Cliente cadastrado/)).toBeTruthy();
    expect(srv.mail.outbox).toHaveLength(2); // só os códigos dos logins do preparo do teste
    expect(srv.table('licenses').filter(l => l.email === 'nova@exemplo.com')).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Voltar à lista' })); await u.click(await screen.findByRole('button', { name: /Cadastrar cliente/ })); await u.type(screen.getByLabelText('E-mail do cliente'), 'nova@exemplo.com'); await u.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByText(/Já existe uma licença/)).toBeTruthy(); expect(srv.table('licenses').filter(l => l.email === 'nova@exemplo.com')).toHaveLength(1);
  });
  it('pesquisa e paginação ("Carregar mais")', async () => {
    for (let i = 0; i < 30; i++) await srv.issueFor(`lote${String(i).padStart(2, '0')}@exemplo.com`);
    const u = userEvent.setup(); open(); await u.click(await screen.findByRole('button', { name: /^Clientes$/ }));
    const list = () => within(screen.getByRole('list', { name: 'Clientes' })).getAllByRole('listitem');
    await waitFor(() => expect(list()).toHaveLength(25)); await u.click(screen.getByRole('button', { name: 'Carregar mais' })); await waitFor(() => expect(list()).toHaveLength(33)); expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    await u.type(screen.getByLabelText('Pesquisar'), 'bruno{enter}'); await waitFor(() => expect(list()).toHaveLength(1)); expect(list()[0].textContent).toContain('bruno@exemplo.com');
  });
  const toDetail = async (u: ReturnType<typeof userEvent.setup>, email: string) => { await u.click(await screen.findByRole('button', { name: /^Clientes$/ })); await u.click(await screen.findByRole('button', { name: `Detalhes de ${email}` })); await screen.findByRole('heading', { name: email }); };
  it('suspender exige digitar o e-mail; só depois do servidor confirmar mostra "Acesso suspenso"', async () => {
    const u = userEvent.setup(); open(); await toDetail(u, 'ana@exemplo.com');
    await u.click(screen.getByRole('button', { name: 'Suspender acesso' })); const go = screen.getByRole('button', { name: 'Suspender' }) as HTMLButtonElement; expect(go.disabled).toBe(true);
    await u.type(screen.getByLabelText(/digite o e-mail/), 'ana@exemplo.com'); expect(go.disabled).toBe(false); await u.click(go);
    expect(await screen.findByText('Acesso suspenso.')).toBeTruthy(); expect(lic('ana@exemplo.com').status).toBe('revoked'); expect(screen.getAllByText('Suspensa').length).toBeGreaterThan(0);
    expect((await srv.request('GET', '/api/sync?since=0', { session: ana })).status).toBe(403); // efeito real no servidor
    await u.click(screen.getByRole('button', { name: 'Reativar acesso' })); await u.click(screen.getByRole('button', { name: 'Reativar' })); expect(await screen.findByText('Acesso reativado.')).toBeTruthy(); expect(lic('ana@exemplo.com').status).toBe('active');
  });
  it('sem requisições redundantes: a permissão é consultada uma vez e nada é repetido por temporizador ou renderização', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      open(); await toDetail(u, 'ana@exemplo.com');
      await u.click(screen.getByRole('button', { name: 'Suspender acesso' })); await u.type(screen.getByLabelText(/digite o e-mail/), 'ana@exemplo.com'); await u.click(screen.getByRole('button', { name: 'Suspender' })); await screen.findByText('Acesso suspenso.');
      const before = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length; await vi.advanceTimersByTimeAsync(10 * 60_000);
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
      expect(calls.filter(c => c.endsWith('/api/admin/me'))).toHaveLength(1); expect(calls.length).toBe(before); // 10 minutos parado: nenhuma requisição
    } finally { vi.useRealTimers(); }
  });
  it('FALHA DE REDE ao suspender: nada é confirmado, a tela avisa e o servidor segue inalterado', async () => {
    const u = userEvent.setup(); open(); await toDetail(u, 'ana@exemplo.com');
    await u.click(screen.getByRole('button', { name: 'Suspender acesso' })); await u.type(screen.getByLabelText(/digite o e-mail/), 'ana@exemplo.com');
    flaky = { network: true, path: /\/suspend$/ }; await u.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(await screen.findByText(/NÃO foi confirmada/)).toBeTruthy(); expect(screen.queryByText('Acesso suspenso.')).toBeNull(); expect(lic('ana@exemplo.com').status).toBe('active');
    flaky = { network: false }; await u.click(screen.getByRole('button', { name: 'Suspender' })); expect(await screen.findByText('Acesso suspenso.')).toBeTruthy(); // tentar de novo funciona
  });
  it('revogar uma sessão e todas: pede confirmação e a sessão sai da lista só depois do servidor', async () => {
    const second = await srv.login('ana@exemplo.com', 'Notebook da Ana', '10.0.0.2');
    const u = userEvent.setup(); open(); await toDetail(u, 'ana@exemplo.com');
    expect(await screen.findByText('Sessões ativas (2)')).toBeTruthy();
    await u.click(screen.getAllByRole('button', { name: 'Revogar' })[0]); await u.click(screen.getByRole('button', { name: 'Cancelar' })); expect((await srv.request('GET', '/api/auth/session', { session: ana })).status).toBe(200); // cancelar não revoga
    await u.click(screen.getAllByRole('button', { name: 'Revogar' })[0]); const dialog = screen.getByRole('dialog', { hidden: true }) ?? document.body; await u.click(within(dialog).getByRole('button', { name: 'Revogar' }));
    expect(await screen.findByText('Sessão revogada.')).toBeTruthy(); expect(await screen.findByText('Sessões ativas (1)')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Revogar todas as sessões' })); const go = screen.getByRole('button', { name: 'Revogar todas' }) as HTMLButtonElement; expect(go.disabled).toBe(true);
    await u.type(screen.getByLabelText(/digite o e-mail/), 'ana@exemplo.com'); await u.click(go);
    expect(await screen.findByText('Sessões revogadas: 1.')).toBeTruthy(); expect(await screen.findByText('Sessões ativas (0)')).toBeTruthy();
    for (const s of [ana, second]) expect((await srv.request('GET', '/api/auth/session', { session: s })).status).toBe(401);
  });
  it('histórico mostra as ações; sessão expirada durante a ação leva ao login (sem falsa confirmação)', async () => {
    const u = userEvent.setup(); open(); await toDetail(u, 'ana@exemplo.com');
    await u.click(screen.getByRole('button', { name: 'Suspender acesso' })); await u.type(screen.getByLabelText(/digite o e-mail/), 'ana@exemplo.com');
    srv.db.raw.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run('2026-11-12T15:00:00.000Z', owner.sessionId); // a sessão do dono foi revogada em outro lugar
    await u.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy(); expect(lic('ana@exemplo.com').status).toBe('active'); expect(screen.queryByText('Acesso suspenso.')).toBeNull();
  });
  it('sair: com falha de rede continua conectado e não confirma; depois funciona', async () => {
    const u = userEvent.setup(); open(); await screen.findByRole('heading', { name: 'Visão geral' });
    flaky = { network: true, path: /logout/ }; await u.click(screen.getByRole('button', { name: /^Sair$/ }));
    expect(await screen.findByText(/Você continua conectado/)).toBeTruthy(); expect(screen.queryByRole('heading', { name: 'Entrar' })).toBeNull();
    flaky = { network: false }; await u.click(screen.getByRole('button', { name: /^Sair$/ })); expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect((await srv.request('GET', '/api/auth/session', { session: owner })).status).toBe(401);
  });
});
