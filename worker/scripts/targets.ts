/**
 * Ambientes de administração do D1. Fonte única usada pelos CLIs (`licenses`, `d1`): cada ambiente tem UM banco e UM `--env` do
 * Wrangler, e nunca existe um padrão implícito para operações remotas. Os nomes precisam coincidir com `worker/wrangler.toml`
 * (há um teste que confere).
 */
export type EnvName = 'local' | 'staging' | 'production' | 'restore';
export type Target = { name: EnvName; database: string; /** valor de --env do Wrangler (nenhum no local) */ wranglerEnv?: string; remote: boolean; label: string };
export const WRANGLER_CONFIG = 'worker/wrangler.toml';

export const TARGETS: Record<EnvName, Target> = {
  local: { name: 'local', database: 'dabi-orcamentos', remote: false, label: 'LOCAL (arquivo de desenvolvimento, nada remoto)' },
  staging: { name: 'staging', database: 'dabi-orcamentos-staging', wranglerEnv: 'staging', remote: true, label: 'REMOTO — HOMOLOGAÇÃO (Cloudflare)' },
  production: { name: 'production', database: 'dabi-orcamentos-producao', wranglerEnv: 'production', remote: true, label: 'REMOTO — PRODUÇÃO (Cloudflare, dados reais)' },
  restore: { name: 'restore', database: 'dabi-orcamentos-restauracao', wranglerEnv: 'restore', remote: true, label: 'REMOTO — ENSAIO DE RESTAURAÇÃO (Cloudflare)' },
};
export const isEnvName = (v: string): v is EnvName => Object.prototype.hasOwnProperty.call(TARGETS, v);

/** Argumentos de ambiente comuns a todos os comandos do Wrangler: config, --env (se houver) e --local/--remote. */
export const wranglerScope = (t: Target): string[] => ['--config', WRANGLER_CONFIG, ...(t.wranglerEnv ? ['--env', t.wranglerEnv] : []), t.remote ? '--remote' : '--local'];

export type Selection = { ok: true; target: Target } | { ok: false; error: string };
/**
 * Resolve o ambiente a partir de `--env <local|staging|production|restore>`. `--local` é aceito como sinônimo de `--env local`.
 * `--remote` sozinho NUNCA é aceito (não diz qual banco) e combinações contraditórias são erro.
 */
export function selectTarget(argv: readonly string[], allowed: readonly EnvName[] = ['local', 'staging', 'production']): Selection {
  const envIdx = argv.flatMap((a, i) => (a === '--env' ? [i] : a.startsWith('--env=') ? [i] : []));
  if (envIdx.length > 1) return { ok: false, error: 'informe --env uma única vez.' };
  const local = argv.includes('--local'), remote = argv.includes('--remote');
  let name: string | undefined;
  if (envIdx.length === 1) {
    const a = argv[envIdx[0]];
    name = a.startsWith('--env=') ? a.slice(6) : argv[envIdx[0] + 1];
    if (!name || name.startsWith('--')) return { ok: false, error: '--env exige um valor: local, staging ou production.' };
  }
  if (name === undefined) {
    if (remote) return { ok: false, error: '--remote sozinho não é aceito: use --env staging ou --env production para escolher o banco.' };
    if (!local) return { ok: false, error: 'informe o ambiente: --env local, --env staging ou --env production.' };
    name = 'local';
  }
  if (!isEnvName(name)) return { ok: false, error: `ambiente desconhecido "${name}". Use: ${allowed.join(', ')}.` };
  if (!allowed.includes(name)) return { ok: false, error: `o ambiente "${name}" não é permitido neste comando (permitidos: ${allowed.join(', ')}).` };
  const t = TARGETS[name];
  if (local && t.remote) return { ok: false, error: `--local contradiz --env ${name}.` };
  if (remote && !t.remote) return { ok: false, error: `--remote contradiz --env ${name}.` };
  return { ok: true, target: t };
}

export const banner = (t: Target, what: string): string => `\n=== ${what} ===\n  Ambiente: ${t.name}\n  Banco:    ${t.database}\n  Destino:  ${t.label}\n`;

export type ConfirmDeps = { isTTY: boolean; prompt(question: string): Promise<string> };
/**
 * Confirmação adicional para operações destrutivas em PRODUÇÃO. O valor esperado (`expected`) é específico da operação
 * (o id da licença ou o nome do banco), então um comando copiado de outro lugar não passa por engano.
 *  - Interativo: o operador digita o valor esperado.
 *  - Não interativo (automação autorizada): exige `--confirm-production <valor>` com o mesmo valor.
 * Fora de produção a confirmação não se aplica; passar `--confirm-production` lá é erro (combinação incoerente).
 */
export async function confirmProduction(t: Target, expected: string, provided: string | undefined, deps: ConfirmDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  if (t.name !== 'production') return provided === undefined ? { ok: true } : { ok: false, error: '--confirm-production só se aplica a --env production.' };
  if (provided !== undefined) return provided === expected ? { ok: true } : { ok: false, error: `--confirm-production precisa ser exatamente "${expected}".` };
  if (!deps.isTTY) return { ok: false, error: `operação destrutiva em PRODUÇÃO sem terminal interativo: repita o comando com --confirm-production ${expected}` };
  const answer = (await deps.prompt(`Operação DESTRUTIVA em PRODUÇÃO. Para continuar, digite exatamente "${expected}": `)).trim();
  return answer === expected ? { ok: true } : { ok: false, error: 'confirmação não confere; nada foi executado.' };
}
