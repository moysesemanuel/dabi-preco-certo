/** Lógica do CLI de licenças, separada da entrada (`licenses.ts`) para ser testável sem tocar em banco algum. Veja `worker/README.md`. */
import { generateLicenseId, generateLicenseKey, hashLicenseKey, LICENSE_ID_PATTERN } from '../src/licenses.ts';
import { bindLicenseEmailSql, issueLicenseSql, licenseStatusSql, listLicensesSql, revokeLicenseQuotesSql, revokeLicenseSessionsSql, setLicenseStatusSql } from '../src/licenseAdmin.ts';
import { activeAdminCountSql, adminAuditSql, adminByEmailSql, grantAdminSql, listAdminsSql, revokeAdminSql } from '../src/adminGrant.ts';
import { banner, confirmProduction, selectTarget, wranglerScope, type ConfirmDeps, type Target } from './targets.ts';

export type CliDeps = ConfirmDeps & {
  /** Executa `npx <args>` e devolve a saída. Nos testes é uma simulação: nenhum banco real é acessado. */
  exec(args: string[]): string;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
};

const COMMANDS = {
  issue: { positional: 0, options: ['--email', '--label', '--quota-active', '--quota-daily'], flags: [] as string[] },
  bind: { positional: 1, options: ['--email'], flags: [] },
  status: { positional: 1, options: [], flags: [] },
  list: { positional: 0, options: [], flags: [] },
  revoke: { positional: 1, options: [], flags: ['--revoke-quotes'] },
  'revoke-sessions': { positional: 1, options: [], flags: [] },
  activate: { positional: 1, options: [], flags: [] },
  'grant-admin': { positional: 0, options: ['--email'], flags: ['--additional'] },
  'revoke-admin': { positional: 0, options: ['--email'], flags: [] },
  'list-admins': { positional: 0, options: [], flags: [] },
} as const;
type Command = keyof typeof COMMANDS;
const DESTRUCTIVE = new Set<Command>(['revoke', 'revoke-sessions', 'grant-admin', 'revoke-admin']);
const GLOBAL_OPTIONS = ['--env', '--confirm-production'];
const GLOBAL_FLAGS = ['--local'];
const USAGE = 'Uso: npm run licenses -- <comando> --env local|staging|production\n  grant-admin --email e [--additional] | revoke-admin --email e | list-admins\n  issue [--email e] [--label l] [--quota-active n] [--quota-daily n] | bind <lic_id> --email e | status <lic_id> | list\n  revoke <lic_id> [--revoke-quotes] | revoke-sessions <lic_id> | activate <lic_id>\n  Em produção, revoke e revoke-sessions exigem confirmação (digitada ou --confirm-production <lic_id>).';

export type Plan = { command: Command; licenseId?: string; options: Record<string, string>; flags: Set<string>; target: Target; confirm?: string };

/** Valida TODAS as combinações antes de qualquer ação. */
export function parseCli(argv: readonly string[]): { ok: true; plan: Plan } | { ok: false; error: string } {
  const command = argv[0] as Command | undefined;
  if (!command || !(command in COMMANDS)) return { ok: false, error: `comando inválido ou ausente.\n${USAGE}` };
  const spec = COMMANDS[command];
  const valueOpts = new Set<string>([...spec.options, ...GLOBAL_OPTIONS]);
  const flagSet = new Set<string>([...spec.flags, ...GLOBAL_FLAGS, '--remote']); // --remote é reconhecido só para ser recusado com explicação
  const options: Record<string, string> = {}; const flags = new Set<string>(); const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    if (a.startsWith('--')) {
      if (valueOpts.has(key)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined || v === '' || v.startsWith('--')) return { ok: false, error: `${key} exige um valor.` };
        if (key in options) return { ok: false, error: `${key} foi informado mais de uma vez.` };
        options[key] = v;
      } else if (flagSet.has(a)) {
        if (flags.has(a)) return { ok: false, error: `${a} foi informado mais de uma vez.` };
        flags.add(a);
      } else return { ok: false, error: `opção "${a}" não existe ou não se aplica ao comando "${command}".` };
    } else positional.push(a);
  }
  if (positional.length !== spec.positional) return { ok: false, error: spec.positional ? `"${command}" exige exatamente um <lic_id>.` : `"${command}" não aceita argumentos soltos (recebeu: ${positional.join(' ')}).` };
  const licenseId = positional[0];
  if (licenseId !== undefined && !LICENSE_ID_PATTERN.test(licenseId)) return { ok: false, error: 'identificador de licença inválido (esperado lic_ + 16 hexadecimais).' };
  if ((command === 'grant-admin' || command === 'revoke-admin') && !options['--email']) return { ok: false, error: `"${command}" exige --email.` };
  if (command === 'bind' && !options['--email']) return { ok: false, error: '"bind" exige --email.' };
  for (const q of ['--quota-active', '--quota-daily']) if (q in options && !/^\d{1,7}$/.test(options[q])) return { ok: false, error: `${q} deve ser um inteiro entre 0 e 1.000.000.` };
  // Ambiente: reconstrói só os argumentos que dizem respeito a ele.
  const envArgs = [...(options['--env'] ? ['--env', options['--env']] : []), ...(flags.has('--local') ? ['--local'] : []), ...(flags.has('--remote') ? ['--remote'] : [])];
  const sel = selectTarget(envArgs);
  if (!sel.ok) return { ok: false, error: sel.error };
  if ('--confirm-production' in options && !DESTRUCTIVE.has(command)) return { ok: false, error: '--confirm-production só se aplica a operações destrutivas (revoke, revoke-sessions, grant-admin, revoke-admin).' };
  if ('--confirm-production' in options && sel.target.name !== 'production') return { ok: false, error: '--confirm-production só se aplica a --env production.' };
  return { ok: true, plan: { command, licenseId, options, flags, target: sel.target, confirm: options['--confirm-production'] } };
}

/** Argumentos EXATOS entregues ao Wrangler para executar SQL no ambiente escolhido. */
export const d1ExecuteArgs = (t: Target, sql: string): string[] => ['wrangler', 'd1', 'execute', t.database, ...wranglerScope(t), '--json', '--command', sql];

const dayStart = (now: Date) => `${new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10)}T03:00:00.000Z`;

export async function runLicensesCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) { deps.err(`Erro: ${parsed.error}`); return 1; }
  const { command, licenseId, options, flags, target, confirm } = parsed.plan;
  const d1 = (sql: string): Record<string, unknown>[] => {
    const out = deps.exec(d1ExecuteArgs(target, sql));
    const json = JSON.parse(out.slice(out.indexOf('[')));
    return json[0]?.results ?? [];
  };
  const iso = () => deps.now().toISOString();
  const show = (rows: Record<string, unknown>[]) => deps.out(rows.map(r => `${r.id}  ${r.status}  ${r.email ?? '-'}  rótulo=${r.label ?? '-'}  dispositivos=${r.active_sessions}  ativos=${r.active_quotes}/${r.quota_active}  hoje=${r.created_today}/${r.quota_daily}  criada=${r.created_at}${r.revoked_at ? `  revogada=${r.revoked_at}` : ''}`).join('\n'));

  try {
    // 1) O destino é SEMPRE exibido antes de qualquer operação.
    deps.err(banner(target, `licenses ${command}${licenseId ? ` ${licenseId}` : ''}`));
    // 2) Confirmação adicional para o que é destrutivo em produção (antes de tocar no banco).
    if (DESTRUCTIVE.has(command)) {
      const c = await confirmProduction(target, (licenseId ?? options['--email']) as string, confirm, deps);
      if (!c.ok) { deps.err(`Erro: ${c.error}`); return 1; }
    }
    if (command === 'issue') {
      const key = generateLicenseKey(); const id = generateLicenseId(); const email = options['--email'];
      d1(issueLicenseSql({ id, keyHash: await hashLicenseKey(key), label: options['--label'], email, quotaActive: Number(options['--quota-active'] ?? 100), quotaDaily: Number(options['--quota-daily'] ?? 30), now: iso() }));
      if (email) deps.out(`\nLicença de conta emitida.\n  Proprietário (ID interno): ${id}\n  E-mail do comprador: ${email}\n  Ambiente/banco: ${target.name} / ${target.database}\n\nO comprador acessa com o código enviado a esse e-mail (2 dispositivos).`);
      else deps.out(`\nLicença emitida (modo chave legado).\n  Proprietário (ID interno): ${id}\n  Ambiente/banco: ${target.name} / ${target.database}\n\n  CHAVE (exibida somente agora; não é possível recuperá-la depois):\n\n    ${key}\n\nA chave só funciona com LEGACY_KEY_AUTH=on; prefira licenças de conta (--email).`);
    } else if (command === 'status') {
      const rows = d1(licenseStatusSql(licenseId as string, dayStart(deps.now())));
      if (!rows.length) { deps.err('Erro: licença não encontrada neste ambiente.'); return 1; }
      show(rows);
    } else if (command === 'list') {
      show(d1(listLicensesSql(dayStart(deps.now()))));
    } else if (command === 'revoke') {
      d1(setLicenseStatusSql(licenseId as string, 'revoked', iso()));
      d1(revokeLicenseSessionsSql(licenseId as string, iso()));
      if (flags.has('--revoke-quotes')) d1(revokeLicenseQuotesSql(licenseId as string, iso()));
      deps.out(`Licença ${licenseId} revogada em ${target.name}${flags.has('--revoke-quotes') ? ' e seus orçamentos ativos foram retirados do ar' : ' (os orçamentos já publicados continuam acessíveis)'}.`);
    } else if (command === 'bind') {
      d1(bindLicenseEmailSql(licenseId as string, options['--email']));
      deps.out(`Licença ${licenseId} vinculada a ${options['--email']} em ${target.name} (apenas se ainda não tinha e-mail).`);
    } else if (command === 'revoke-sessions') {
      d1(revokeLicenseSessionsSql(licenseId as string, iso()));
      deps.out(`Dispositivos da conta da licença ${licenseId} desconectados em ${target.name}.`);
    } else if (command === 'grant-admin') {
      const e = options['--email'];
      // Bootstrap único: com um administrador ativo já existente, só com --additional (decisão consciente).
      const n = Number(d1(activeAdminCountSql())[0]?.n ?? 0);
      if (n > 0 && !flags.has('--additional')) { deps.err('Erro: já existe um administrador ativo. Para conceder a outro, repita com --additional.'); return 1; }
      d1(grantAdminSql(e, iso()));
      if (!d1(adminByEmailSql(e)).length) { deps.err('Erro: nenhum usuário ativo com este e-mail. A pessoa precisa ter feito o primeiro login (e a conta não pode estar desativada).'); return 1; }
      d1(adminAuditSql('admin.grant', e, iso()));
      deps.out(`Acesso administrativo concedido a ${e} em ${target.name}. O painel exige, além disso, licença ativa e sessão válida.`);
    } else if (command === 'revoke-admin') {
      const e = options['--email'];
      d1(revokeAdminSql(e, iso())); d1(adminAuditSql('admin.revoke', e, iso()));
      deps.out(`Acesso administrativo de ${e} revogado em ${target.name} (se existia).`);
    } else if (command === 'list-admins') {
      deps.out(d1(listAdminsSql()).map(r => `${r.email}  ${r.role}  concedido=${r.granted_at} por ${r.granted_by}${r.revoked_at ? `  REVOGADO=${r.revoked_at}` : ''}`).join('\n') || '(nenhum administrador)');
    } else if (command === 'activate') {
      d1(setLicenseStatusSql(licenseId as string, 'active', iso()));
      deps.out(`Licença ${licenseId} reativada em ${target.name}.`);
    }
    return 0;
  } catch (error) {
    // Nunca imprime o comando executado nem a chave; só a primeira linha da mensagem.
    deps.err(`Erro: ${error instanceof Error ? error.message.split('\n')[0] : 'falha inesperada.'}`);
    return 1;
  }
}
