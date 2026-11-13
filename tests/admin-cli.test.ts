import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { d1Args, parseD1, runD1Cli, type D1Deps } from '../worker/scripts/d1Cli';
import { d1ExecuteArgs, parseCli, runLicensesCli, type CliDeps } from '../worker/scripts/licensesCli';
import { TARGETS, selectTarget } from '../worker/scripts/targets';

// Nenhum teste acessa Wrangler, Cloudflare ou banco real: `exec` é uma simulação que só registra os argumentos.
const LIC = 'lic_0123456789abcdef';
const OTHER = 'lic_fedcba9876543210';
type Rec = { calls: string[][]; outLines: string[]; errLines: string[]; prompts: string[] };
function deps(over: Partial<CliDeps> & { answer?: string } = {}): CliDeps & Rec {
  const { answer, ...fns } = over;
  const rec: Rec = { calls: [], outLines: [], errLines: [], prompts: [] };
  return Object.assign(rec, {
    exec: (a: string[]) => { rec.calls.push(a); return '[{"results":[]}]'; },
    out: (l: string) => { rec.outLines.push(l); },
    err: (l: string) => { rec.errLines.push(l); },
    now: () => new Date('2026-11-12T15:00:00Z'),
    isTTY: false,
    prompt: async (q: string) => { rec.prompts.push(q); return answer ?? ''; },
    ...fns,
  }) as CliDeps & Rec;
}
const run = async (argv: string[], over: Partial<CliDeps> & { answer?: string } = {}) => { const d = deps(over); const code = await runLicensesCli(argv, d); return { code, d }; };
const scopeOf = (args: string[]) => args.slice(args.indexOf('--config'), args.indexOf('--json'));

describe('Ambientes: argumentos EXATOS entregues ao Wrangler (licenças)', () => {
  it('local: banco de desenvolvimento, --local e nenhum --env', async () => {
    const { code, d } = await run(['list', '--env', 'local']);
    expect(code).toBe(0);
    expect(d.calls[0].slice(0, 4)).toEqual(['wrangler', 'd1', 'execute', 'dabi-orcamentos']);
    expect(scopeOf(d.calls[0])).toEqual(['--config', 'worker/wrangler.toml', '--local']);
    expect(d.calls[0]).not.toContain('--env'); expect(d.calls[0]).not.toContain('--remote');
  });
  it('staging: D1 dabi-orcamentos-staging, --env staging e --remote', async () => {
    const { code, d } = await run(['issue', '--env', 'staging', '--email', 'teste@exemplo.test', '--label', 'homologação']);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].slice(0, 4)).toEqual(['wrangler', 'd1', 'execute', 'dabi-orcamentos-staging']);
    expect(scopeOf(d.calls[0])).toEqual(['--config', 'worker/wrangler.toml', '--env', 'staging', '--remote']);
    expect(d.calls[0].join(' ')).not.toContain('producao');
  });
  it('production: D1 dabi-orcamentos-producao, --env production e --remote', async () => {
    const { d } = await run(['status', LIC, '--env', 'production']);
    expect(d.calls[0].slice(0, 4)).toEqual(['wrangler', 'd1', 'execute', 'dabi-orcamentos-producao']);
    expect(scopeOf(d.calls[0])).toEqual(['--config', 'worker/wrangler.toml', '--env', 'production', '--remote']);
  });
  it('a forma --env=staging e o sinônimo --local funcionam; todo comando de um ambiente usa SEMPRE o mesmo banco', async () => {
    expect((await run(['list', '--env=staging'])).d.calls[0][3]).toBe('dabi-orcamentos-staging');
    expect((await run(['list', '--local'])).d.calls[0][3]).toBe('dabi-orcamentos');
    const { d } = await run(['revoke', LIC, '--env', 'staging', '--revoke-quotes']); // várias instruções, mesmo destino
    expect(d.calls.length).toBe(3);
    for (const c of d.calls) { expect(c[3]).toBe('dabi-orcamentos-staging'); expect(scopeOf(c)).toContain('staging'); }
  });
  it('o SQL vai em --command e a chave de licença nunca aparece nos argumentos', async () => {
    const { d, code } = await run(['issue', '--env', 'staging', '--label', 'x']);
    expect(code).toBe(0);
    expect(d.calls[0].join(' ')).not.toMatch(/dabi_lic_/);
    expect(d.calls[0][d.calls[0].indexOf('--command') + 1]).toMatch(/^INSERT INTO licenses/);
    expect(d1ExecuteArgs(TARGETS.staging, 'SELECT 1').slice(-2)).toEqual(['--command', 'SELECT 1']);
  });
  it('exibe ambiente e banco ANTES de qualquer chamada ao Wrangler', async () => {
    const order: string[] = [];
    const d = deps({ exec: a => { order.push('exec'); void a; return '[{"results":[]}]'; }, err: l => order.push(`err:${l.replace(/\n/g, '|')}`) });
    await runLicensesCli(['list', '--env', 'staging'], d);
    expect(order[0]).toContain('Ambiente: staging'); expect(order[0]).toContain('Banco:    dabi-orcamentos-staging'); expect(order[0]).toContain('HOMOLOGAÇÃO');
    expect(order.indexOf('exec')).toBeGreaterThan(0);
  });
});

describe('Ambiente explícito e combinações incoerentes (nada é executado)', () => {
  const bad: [string, string[], RegExp][] = [
    ['sem ambiente', ['list'], /informe o ambiente/],
    ['--remote sozinho', ['issue', '--remote'], /--remote sozinho não é aceito/],
    ['--remote e --local', ['list', '--remote', '--local'], /--remote sozinho|contradiz/],
    ['--local com staging', ['list', '--local', '--env', 'staging'], /contradiz/],
    ['--remote com local', ['list', '--remote', '--env', 'local'], /contradiz/],
    ['ambiente desconhecido', ['list', '--env', 'prod'], /desconhecido/],
    ['ambiente restore não vale para licenças', ['list', '--env', 'restore'], /não é permitido/],
    ['--env duplicado', ['list', '--env', 'staging', '--env', 'production'], /mais de uma vez/],
    ['--env sem valor', ['list', '--env'], /exige/],
    ['--env engole a próxima opção', ['list', '--env', '--local'], /exige/],
    ['comando inexistente', ['apagar', '--env', 'local'], /inválido/],
    ['sem comando', [], /inválido/],
    ['opção desconhecida', ['list', '--env', 'local', '--force'], /não existe/],
    ['--revoke-quotes fora de revoke', ['status', LIC, '--env', 'local', '--revoke-quotes'], /não existe ou não se aplica/],
    ['--email fora de issue/bind', ['status', LIC, '--env', 'local', '--email', 'a@b.test'], /não existe ou não se aplica/],
    ['--label em revoke', ['revoke', LIC, '--env', 'local', '--label', 'x'], /não existe ou não se aplica/],
    ['issue com id solto', ['issue', LIC, '--env', 'local'], /argumentos soltos/],
    ['revoke sem id', ['revoke', '--env', 'local'], /exatamente um/],
    ['revoke com dois ids', ['revoke', LIC, OTHER, '--env', 'local'], /exatamente um/],
    ['id malformado', ['status', 'lic_123', '--env', 'local'], /inválido/],
    ['bind sem e-mail', ['bind', LIC, '--env', 'local'], /exige --email/],
    ['cota inválida', ['issue', '--env', 'local', '--quota-active', '-5'], /exige um valor|inteiro/],
    ['cota não numérica', ['issue', '--env', 'local', '--quota-daily', 'muitas'], /inteiro/],
    ['opção repetida', ['issue', '--env', 'local', '--label', 'a', '--label', 'b'], /mais de uma vez/],
    ['--confirm-production fora de produção', ['revoke', LIC, '--env', 'staging', '--confirm-production', LIC], /só se aplica a --env production/],
    ['--confirm-production em comando não destrutivo', ['issue', '--env', 'production', '--confirm-production', LIC], /só se aplica a operações destrutivas/],
  ];
  it.each(bad)('%s', async (_n, argv, re) => {
    const { code, d } = await run(argv);
    expect(code).toBe(1);
    expect(d.errLines.join('\n')).toMatch(re);
    expect(d.calls).toHaveLength(0);
    expect(d.prompts).toHaveLength(0);
  });
  it('selectTarget e parseCli concordam sobre ambientes permitidos', () => {
    expect(selectTarget(['--env', 'restore'], ['local', 'staging', 'production', 'restore']).ok).toBe(true);
    expect(parseCli(['list', '--env', 'production']).ok).toBe(true);
  });
});

describe('Produção: confirmação adicional para operações destrutivas', () => {
  it('não interativo sem --confirm-production: recusa e não toca no banco', async () => {
    for (const argv of [['revoke', LIC, '--env', 'production'], ['revoke-sessions', LIC, '--env', 'production'], ['revoke', LIC, '--env', 'production', '--revoke-quotes']]) {
      const { code, d } = await run(argv, { isTTY: false });
      expect(code).toBe(1); expect(d.calls).toHaveLength(0);
      expect(d.errLines.join('\n')).toContain(`--confirm-production ${LIC}`);
    }
  });
  it('não interativo com --confirm-production igual ao id: executa no banco de PRODUÇÃO', async () => {
    const { code, d } = await run(['revoke', LIC, '--env', 'production', '--confirm-production', LIC], { isTTY: false });
    expect(code).toBe(0);
    expect(d.calls.length).toBe(2);
    for (const c of d.calls) { expect(c[3]).toBe('dabi-orcamentos-producao'); expect(scopeOf(c)).toEqual(['--config', 'worker/wrangler.toml', '--env', 'production', '--remote']); }
  });
  it('confirmação de OUTRA licença não vale (não dá para reaproveitar um comando copiado)', async () => {
    const { code, d } = await run(['revoke', LIC, '--env', 'production', '--confirm-production', OTHER]);
    expect(code).toBe(1); expect(d.calls).toHaveLength(0);
  });
  it('interativo: pede para digitar o id; resposta errada cancela, certa executa', async () => {
    const wrong = await run(['revoke-sessions', LIC, '--env', 'production'], { isTTY: true, answer: 'sim' });
    expect(wrong.code).toBe(1); expect(wrong.d.calls).toHaveLength(0); expect(wrong.d.prompts[0]).toContain(LIC);
    const right = await run(['revoke-sessions', LIC, '--env', 'production'], { isTTY: true, answer: LIC });
    expect(right.code).toBe(0); expect(right.d.calls).toHaveLength(1);
  });
  it('homologação e local NÃO pedem confirmação; emitir/consultar/reativar em produção também não são destrutivos', async () => {
    for (const argv of [['revoke', LIC, '--env', 'staging'], ['revoke', LIC, '--env', 'local'], ['activate', LIC, '--env', 'production'], ['list', '--env', 'production']]) {
      const { code, d } = await run(argv, { isTTY: false });
      expect(code, argv.join(' ')).toBe(0); expect(d.prompts).toHaveLength(0);
    }
  });
  it('status em produção é leitura: sem confirmação', async () => {
    const { code, d } = await run(['status', LIC, '--env', 'production'], { exec: () => '[{"results":[{"id":"lic_0123456789abcdef","status":"active"}]}]' });
    expect(code).toBe(0); expect(d.prompts).toHaveLength(0);
  });
  it('a confirmação acontece depois de exibir o destino e antes de qualquer chamada', async () => {
    const order: string[] = [];
    const d = deps({ isTTY: true, answer: LIC, err: l => order.push(l.includes('Ambiente') ? 'banner' : 'err'), prompt: async () => { order.push('prompt'); return LIC; }, exec: () => { order.push('exec'); return '[{"results":[]}]'; } });
    await runLicensesCli(['revoke', LIC, '--env', 'production'], d);
    expect(order.slice(0, 3)).toEqual(['banner', 'prompt', 'exec']);
  });
  it('falha do Wrangler: erro curto, sem imprimir o comando nem o SQL', async () => {
    const d = deps({ exec: () => { throw new Error('Authentication error [code: 10000]\nlinha 2 com INSERT INTO licenses'); } });
    expect(await runLicensesCli(['list', '--env', 'staging'], d)).toBe(1);
    expect(d.errLines.join('\n')).toContain('Authentication error');
    expect(d.errLines.join('\n')).not.toContain('INSERT INTO');
  });
});

describe('CLI do D1 (migrar, exportar, restaurar)', () => {
  function d1deps(over: Partial<D1Deps> & { answer?: string } = {}) {
    const calls: string[][] = []; const err: string[] = []; const prompts: string[] = [];
    const d: D1Deps = { exec: a => { calls.push(a); }, out: () => undefined, err: l => err.push(l), isTTY: false, prompt: async q => { prompts.push(q); return over.answer ?? ''; }, ...over };
    return { d, calls, err, prompts };
  }
  const go = async (argv: string[], over: Partial<D1Deps> & { answer?: string } = {}) => { const x = d1deps(over); const code = await runD1Cli(argv, x.d); return { code, ...x }; };

  it('migrate usa o banco e o --env do ambiente escolhido', async () => {
    expect((await go(['migrate', '--env', 'local'])).calls[0]).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'dabi-orcamentos', '--config', 'worker/wrangler.toml', '--local']);
    expect((await go(['migrate', '--env', 'staging'])).calls[0]).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'dabi-orcamentos-staging', '--config', 'worker/wrangler.toml', '--env', 'staging', '--remote']);
  });
  it('export: somente leitura, sem confirmação, com o banco certo', async () => {
    const r = await go(['export', '--env', 'production', '--output', 'backup-2026-11-12.sql']);
    expect(r.code).toBe(0); expect(r.prompts).toHaveLength(0);
    expect(r.calls[0]).toEqual(['wrangler', 'd1', 'export', 'dabi-orcamentos-producao', '--config', 'worker/wrangler.toml', '--env', 'production', '--remote', '--output', 'backup-2026-11-12.sql']);
  });
  it('migrate em produção exige confirmação com o NOME DO BANCO (digitada ou --confirm-production)', async () => {
    const no = await go(['migrate', '--env', 'production']);
    expect(no.code).toBe(1); expect(no.calls).toHaveLength(0); expect(no.err.join('\n')).toContain('--confirm-production dabi-orcamentos-producao');
    const yes = await go(['migrate', '--env', 'production', '--confirm-production', 'dabi-orcamentos-producao']);
    expect(yes.code).toBe(0); expect(yes.calls[0][4]).toBe('dabi-orcamentos-producao'); expect(yes.calls[0]).toContain('production');
    const typed = await go(['migrate', '--env', 'production'], { isTTY: true, answer: 'dabi-orcamentos-producao' });
    expect(typed.code).toBe(0);
  });
  it('restore-file: nunca em produção; vai para o banco de ensaio, homologação ou local', async () => {
    const prod = await go(['restore-file', '--env', 'production', '--file', 'b.sql']);
    expect(prod.code).toBe(1); expect(prod.calls).toHaveLength(0); expect(prod.err.join('\n')).toMatch(/não é permitido/);
    const r = await go(['restore-file', '--env', 'restore', '--file', 'backup.sql']);
    expect(r.calls[0]).toEqual(['wrangler', 'd1', 'execute', 'dabi-orcamentos-restauracao', '--config', 'worker/wrangler.toml', '--env', 'restore', '--remote', '--file', 'backup.sql']);
    expect((await go(['restore-file', '--env', 'staging', '--file', 'backup.sql'])).calls[0][3]).toBe('dabi-orcamentos-staging');
  });
  it('time-travel: info é leitura; restore em produção exige confirmação e leva --env e banco corretos', async () => {
    expect((await go(['time-travel-info', '--env', 'production'])).calls[0]).toEqual(['wrangler', 'd1', 'time-travel', 'info', 'dabi-orcamentos-producao', '--config', 'worker/wrangler.toml', '--env', 'production']);
    const no = await go(['time-travel-restore', '--env', 'production', '--timestamp', '2026-11-12T15:00:00Z']);
    expect(no.code).toBe(1); expect(no.calls).toHaveLength(0);
    const ok = await go(['time-travel-restore', '--env', 'production', '--timestamp', '2026-11-12T15:00:00Z', '--confirm-production', 'dabi-orcamentos-producao']);
    expect(ok.calls[0]).toEqual(['wrangler', 'd1', 'time-travel', 'restore', 'dabi-orcamentos-producao', '--config', 'worker/wrangler.toml', '--env', 'production', '--timestamp', '2026-11-12T15:00:00Z']);
    expect((await go(['time-travel-info', '--env', 'local'])).code).toBe(1); // time travel não existe no local
  });
  const bad: [string, string[]][] = [
    ['sem ambiente', ['migrate']], ['--remote sozinho', ['migrate', '--remote']], ['--local com staging', ['export', '--local', '--env', 'staging', '--output', 'a.sql']],
    ['export sem --output', ['export', '--env', 'staging']], ['--output fora do padrão', ['export', '--env', 'staging', '--output', 'a.sql;rm -rf']], ['--output sem .sql', ['export', '--env', 'staging', '--output', 'a.txt']],
    ['--file inválido', ['restore-file', '--env', 'restore', '--file', '$(x).sql']], ['--timestamp inválido', ['time-travel-restore', '--env', 'staging', '--timestamp', 'ontem']],
    ['--confirm-production em staging', ['migrate', '--env', 'staging', '--confirm-production', 'dabi-orcamentos-staging']], ['--confirm-production em export', ['export', '--env', 'production', '--output', 'a.sql', '--confirm-production', 'x']],
    ['argumento solto', ['migrate', 'staging', '--env', 'staging']], ['comando desconhecido', ['drop', '--env', 'staging']],
  ];
  it.each(bad)('recusa: %s', async (_n, argv) => { const r = await go(argv); expect(r.code).toBe(1); expect(r.calls).toHaveLength(0); expect(parseD1(argv).ok).toBe(false); });
  it('exibe ambiente e banco antes de agir', async () => {
    const r = await go(['migrate', '--env', 'staging']);
    expect(r.err[0]).toContain('Ambiente: staging'); expect(r.err[0]).toContain('dabi-orcamentos-staging');
    expect(d1Args({ command: 'migrate', target: TARGETS.staging, options: {} })).toContain('--remote');
  });
});

describe('CLI do D1: verificação somente leitura (migrations-list e query)', () => {
  const go = async (argv: string[]) => { const calls: string[][] = [], err: string[] = []; const code = await runD1Cli(argv, { exec: a => { calls.push(a); }, out: () => undefined, err: l => err.push(l), isTTY: false, prompt: async () => '' } as D1Deps); return { code, calls, err }; };
  it('migrations-list usa o ambiente explícito, o banco certo e --remote; não pede confirmação (não altera nada)', async () => {
    const r = await go(['migrations-list', '--env', 'staging']);
    expect(r.code).toBe(0); expect(r.calls).toEqual([['wrangler', 'd1', 'migrations', 'list', 'dabi-orcamentos-staging', '--config', 'worker/wrangler.toml', '--env', 'staging', '--remote']]);
    expect(r.err[0]).toContain('dabi-orcamentos-staging');
  });
  it('query aceita só SELECT e PRAGMA de estrutura, com o ambiente explícito', async () => {
    const q = 'SELECT name FROM d1_migrations ORDER BY id';
    expect((await go(['query', '--env', 'staging', '--command', q])).calls).toEqual([['wrangler', 'd1', 'execute', 'dabi-orcamentos-staging', '--config', 'worker/wrangler.toml', '--env', 'staging', '--remote', '--command', q]]);
    for (const ok of ['PRAGMA table_info(orders)', 'pragma index_list(orders)', 'SELECT COUNT(*) AS n FROM orders WHERE quote_code IS NULL;']) expect(parseD1(['query', '--env', 'local', '--command', ok]).ok, ok).toBe(true);
  });
  it.each([
    ['sem ambiente', ['query', '--command', 'SELECT 1']], ['sem --command', ['query', '--env', 'staging']],
    ['escrita', ['query', '--env', 'staging', '--command', 'UPDATE orders SET status = 1']], ['apagar', ['query', '--env', 'staging', '--command', 'DELETE FROM orders']],
    ['duas instruções', ['query', '--env', 'staging', '--command', 'SELECT 1; DROP TABLE orders']], ['SELECT disfarçado', ['query', '--env', 'staging', '--command', 'SELECT 1 FROM orders WHERE 1=1 UNION SELECT 1 FROM (DELETE FROM orders)']],
    ['pragma de escrita', ['query', '--env', 'staging', '--command', 'PRAGMA writable_schema=1']], ['--remote sozinho', ['migrations-list', '--remote']], ['--confirm-production não se aplica', ['query', '--env', 'production', '--command', 'SELECT 1', '--confirm-production', 'x']],
  ])('recusa: %s', async (_n, argv) => { const r = await go(argv as string[]); expect(r.code).toBe(1); expect(r.calls).toHaveLength(0); });
});

describe('Publicação do Worker: sempre com ambiente explícito', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  it('o dry-run usa Wrangler explicitamente e o deploy passa pelo guardrail de SHA para staging', () => {
    const deploys = Object.entries(scripts).filter(([, v]) => /wrangler\s+deploy/.test(v));
    expect(deploys.map(([k]) => k)).toEqual(['worker:dry-run:staging']);
    for (const [k, v] of deploys) { expect(v, k).toMatch(/--env staging/); expect(v, k).toContain('--config worker/wrangler.toml'); expect(v, k).not.toMatch(/production|producao/i); }
    expect(scripts['worker:dry-run:staging']).toContain('--dry-run');
    expect(scripts['worker:deploy:staging']).toBe('node scripts/worker.mjs deploy staging --publish');
    const wrapper = readFileSync('scripts/worker.mjs', 'utf8');
    expect(wrapper).toContain("'--env', 'staging', '--config', 'worker/wrangler.toml'");
    expect(wrapper).toContain("'--tag', approvedCommit, '--strict'");
  });
  it('a configuração de homologação não usa curingas nem a origem de produção e tem banco próprio', () => {
    const toml = readFileSync('worker/wrangler.toml', 'utf8');
    const staging = toml.slice(toml.indexOf('[env.staging]'), toml.indexOf('[env.production]'));
    expect(staging).toContain('name = "dabi-orcamentos-staging"'); expect(staging).toMatch(/EMAIL_ADAPTER = "resend"/); expect(staging).toMatch(/PUBLIC_BASE_URL = "https:\/\//);
    expect(staging).not.toMatch(/ALLOWED_ORIGINS = "[^"]*\*/); expect(staging).not.toContain('database_name = "dabi-orcamentos-producao"');
    const id = (block: string) => /database_id = "([^"]+)"/.exec(block)?.[1];
    const prod = toml.slice(toml.indexOf('[env.production]'));
    expect(id(staging)).not.toBe(id(prod));
  });
});

describe('Coerência com worker/wrangler.toml e package.json', () => {
  const toml = readFileSync('worker/wrangler.toml', 'utf8');
  const section = (header: string) => { const i = toml.indexOf(header); const rest = toml.slice(i + header.length); const next = rest.search(/\n\[\[?[a-z]/); return rest.slice(0, next < 0 ? undefined : next); };
  it('cada ambiente aponta para o banco certo, e nenhum nome se repete', () => {
    expect(section('[[d1_databases]]')).toContain(`database_name = "${TARGETS.local.database}"`);
    for (const e of ['staging', 'production', 'restore'] as const) expect(section(`[[env.${e}.d1_databases]]`)).toContain(`database_name = "${TARGETS[e].database}"`);
    const names = Object.values(TARGETS).map(t => t.database);
    expect(new Set(names).size).toBe(names.length);
  });
  it('o --env do Wrangler de cada alvo existe como [env.X] no wrangler.toml', () => {
    for (const t of Object.values(TARGETS)) if (t.wranglerEnv) expect(toml).toContain(`[env.${t.wranglerEnv}]`);
  });
  it('os scripts do package.json não executam nada remoto sem ambiente explícito', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) if (/wrangler|d1\.ts|licenses/.test(cmd)) expect(cmd, name).not.toMatch(/--remote/);
    expect(scripts['worker:migrate']).toContain('--env local');
  });
});
