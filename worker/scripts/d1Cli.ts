/**
 * Operações de banco (migrar, exportar, restaurar) com o MESMO controle de ambiente dos CLIs de licença: ambiente explícito,
 * banco e `--env` do Wrangler derivados de targets.ts, destino exibido antes de agir e confirmação extra para o que altera/substitui
 * dados de PRODUÇÃO. Nenhum comando aqui é executado pelo CI nem pelo repositório: são ações do operador.
 */
import { banner, confirmProduction, selectTarget, wranglerScope, type ConfirmDeps, type EnvName, type Target } from './targets.ts';

export type D1Deps = ConfirmDeps & { exec(args: string[]): void; out(line: string): void; err(line: string): void };

type Spec = { options: string[]; allowedEnvs: EnvName[]; /** altera ou substitui dados (exige confirmação em produção) */ mutating: boolean };
const SPECS = {
  migrate: { options: [], allowedEnvs: ['local', 'staging', 'production', 'restore'], mutating: true },
  export: { options: ['--output'], allowedEnvs: ['local', 'staging', 'production'], mutating: false },
  'restore-file': { options: ['--file'], allowedEnvs: ['local', 'staging', 'restore'], mutating: true }, // nunca produção: use time-travel
  'time-travel-info': { options: [], allowedEnvs: ['staging', 'production'], mutating: false },
  'time-travel-restore': { options: ['--timestamp'], allowedEnvs: ['staging', 'production'], mutating: true },
} as const satisfies Record<string, Spec>;
type Cmd = keyof typeof SPECS;
const USAGE = `Uso: npm run d1 -- <comando> --env <ambiente>
  migrate --env local|staging|production|restore
  export --env local|staging|production --output arquivo.sql
  restore-file --env local|staging|restore --file arquivo.sql        (restaurar em produção só por time-travel-restore)
  time-travel-info --env staging|production
  time-travel-restore --env staging|production --timestamp <ISO-8601>
  Em produção, comandos que alteram dados exigem confirmação (digitada ou --confirm-production <nome-do-banco>).`;

export type D1Plan = { command: Cmd; target: Target; options: Record<string, string>; confirm?: string };

export function parseD1(argv: readonly string[]): { ok: true; plan: D1Plan } | { ok: false; error: string } {
  const command = argv[0] as Cmd | undefined;
  if (!command || !(command in SPECS)) return { ok: false, error: `comando inválido ou ausente.\n${USAGE}` };
  const spec: Spec = SPECS[command];
  const valueOpts = new Set<string>([...spec.options, '--env', '--confirm-production']);
  const options: Record<string, string> = {}; const flags = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { ok: false, error: `argumento solto "${a}" não é aceito.` };
    const eq = a.indexOf('='); const key = eq > 0 ? a.slice(0, eq) : a;
    if (valueOpts.has(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) return { ok: false, error: `${key} exige um valor.` };
      if (key in options) return { ok: false, error: `${key} foi informado mais de uma vez.` };
      options[key] = v;
    } else if (a === '--local' || a === '--remote') { if (flags.has(a)) return { ok: false, error: `${a} foi informado mais de uma vez.` }; flags.add(a); }
    else return { ok: false, error: `opção "${a}" não existe ou não se aplica a "${command}".` };
  }
  const sel = selectTarget([...(options['--env'] ? ['--env', options['--env']] : []), ...flags], spec.allowedEnvs);
  if (!sel.ok) return { ok: false, error: sel.error };
  for (const o of spec.options) if (!(o in options)) return { ok: false, error: `"${command}" exige ${o}.` };
  if ('--output' in options && !/^[\w./-]+\.sql$/.test(options['--output'])) return { ok: false, error: '--output deve ser um caminho .sql simples (letras, números, . _ - /).' };
  if ('--file' in options && !/^[\w./-]+\.sql$/.test(options['--file'])) return { ok: false, error: '--file deve ser um caminho .sql simples (letras, números, . _ - /).' };
  if ('--timestamp' in options && !/^(\d{9,11}|\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.test(options['--timestamp'])) return { ok: false, error: '--timestamp deve ser epoch em segundos ou RFC3339 em UTC (ex.: 2026-11-12T15:00:00Z).' };
  if ('--confirm-production' in options && !spec.mutating) return { ok: false, error: '--confirm-production só se aplica a comandos que alteram dados.' };
  if ('--confirm-production' in options && sel.target.name !== 'production') return { ok: false, error: '--confirm-production só se aplica a --env production.' };
  return { ok: true, plan: { command, target: sel.target, options, confirm: options['--confirm-production'] } };
}

/** Argumentos EXATOS entregues ao Wrangler (depois de `npx`). */
export function d1Args(plan: D1Plan): string[] {
  const { command, target: t, options: o } = plan;
  const db = t.database;
  switch (command) {
    case 'migrate': return ['wrangler', 'd1', 'migrations', 'apply', db, ...wranglerScope(t)];
    case 'export': return ['wrangler', 'd1', 'export', db, ...wranglerScope(t), '--output', o['--output']];
    case 'restore-file': return ['wrangler', 'd1', 'execute', db, ...wranglerScope(t), '--file', o['--file']];
    case 'time-travel-info': return ['wrangler', 'd1', 'time-travel', 'info', db, '--config', 'worker/wrangler.toml', '--env', t.wranglerEnv as string];
    case 'time-travel-restore': return ['wrangler', 'd1', 'time-travel', 'restore', db, '--config', 'worker/wrangler.toml', '--env', t.wranglerEnv as string, '--timestamp', o['--timestamp']];
  }
}

export async function runD1Cli(argv: readonly string[], deps: D1Deps): Promise<number> {
  const parsed = parseD1(argv);
  if (!parsed.ok) { deps.err(`Erro: ${parsed.error}`); return 1; }
  const { plan } = parsed;
  deps.err(banner(plan.target, `d1 ${plan.command}`));
  const spec: Spec = SPECS[plan.command];
  if (spec.mutating) {
    const c = await confirmProduction(plan.target, plan.target.database, plan.confirm, deps);
    if (!c.ok) { deps.err(`Erro: ${c.error}`); return 1; }
  }
  try { deps.exec(d1Args(plan)); return 0; }
  catch (e) { deps.err(`Erro: ${e instanceof Error ? e.message.split('\n')[0] : 'falha inesperada.'}`); return 1; }
}
