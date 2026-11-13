// Build, validação e publicação do front-end no Cloudflare Pages, com ambiente SEMPRE explícito.
//   node scripts/pages.mjs build|check|deploy staging|production [--publish] [--approved-commit SHA40] [--confirm-production dabi-preco-certo]
// Sem --publish nada é enviado à Cloudflare (só build + validação). DNS, segredos, banco e migrações nunca são tocados aqui.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Cada ambiente tem o SEU projeto Pages e o SEU Worker (Service Binding `API`, configurado no projeto). Nunca compartilham nada. */
export const ENVIRONMENTS = {
  staging: { project: 'dabi-preco-certo-staging', branch: 'staging', worker: 'dabi-orcamentos-staging', url: 'https://dabi-preco-certo-staging.pages.dev' },
  production: { project: 'dabi-preco-certo', branch: 'main', worker: 'dabi-orcamentos', url: 'https://precocerto.dabitech.com.br' },
};

export function parseArgs(argv) {
  const [command, env, ...rest] = argv;
  if (!['build', 'check', 'deploy'].includes(command ?? '')) return { ok: false, error: 'comando inválido (build, check ou deploy).' };
  if (!Object.hasOwn(ENVIRONMENTS, env ?? '')) return { ok: false, error: 'informe o ambiente: staging ou production (sem padrão, de propósito).' };
  let publish = false; let confirm; let approvedCommit;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--publish') publish = true;
    else if (rest[i] === '--confirm-production') confirm = rest[++i];
    else if (rest[i] === '--approved-commit') approvedCommit = rest[++i];
    else return { ok: false, error: `opção desconhecida: ${rest[i]}` };
  }
  if (publish && command !== 'deploy') return { ok: false, error: '--publish só existe no comando deploy.' };
  if (confirm !== undefined && env !== 'production') return { ok: false, error: '--confirm-production só se aplica a production.' };
  if (approvedCommit !== undefined && (!publish || command !== 'deploy')) return { ok: false, error: '--approved-commit só se aplica a uma publicação.' };
  if (publish && !/^[0-9a-f]{40}$/i.test(approvedCommit ?? '')) return { ok: false, error: `publicar em ${env} exige --approved-commit com o SHA completo de 40 caracteres.` };
  if (publish && env === 'production' && confirm !== ENVIRONMENTS.production.project) return { ok: false, error: `publicar em PRODUÇÃO exige --confirm-production ${ENVIRONMENTS.production.project}.` };
  return { ok: true, plan: { command, env, publish, approvedCommit, config: ENVIRONMENTS[env] } };
}

/** Só permite publicar os artefatos do commit aprovado em um checkout limpo. */
export function verifyRelease(cwd, env, approvedCommit) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const problems = [];
    if (env === 'production' && git('branch', '--show-current') !== ENVIRONMENTS.production.branch) problems.push(`publicação de produção exige a branch ${ENVIRONMENTS.production.branch}.`);
    if (git('rev-parse', 'HEAD').toLowerCase() !== approvedCommit.toLowerCase()) problems.push('O commit do checkout não é o commit aprovado.');
    if (git('status', '--porcelain', '--untracked-files=all')) problems.push('O checkout precisa estar limpo antes da publicação.');
    return problems;
  } catch { return ['Não foi possível verificar a branch, o commit e a limpeza do checkout com Git.']; }
}
export const verifyStagingRelease = (cwd, approvedCommit) => verifyRelease(cwd, 'staging', approvedCommit);
export const verifyProductionRelease = (cwd, approvedCommit) => verifyRelease(cwd, 'production', approvedCommit);

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Confere o que vai ao ar. Devolve a lista de problemas (vazia = ok). */
export function validateDist(dist = 'dist', root = '.') {
  const problems = [];
  for (const f of ['index.html', '_headers', '_routes.json']) if (!existsSync(join(dist, f))) problems.push(`dist/${f} ausente (rode o build).`);
  if (existsSync(join(dist, '404.html'))) problems.push('dist/404.html existe: isso DESLIGA o modo SPA do Pages e /admin deixaria de funcionar ao atualizar a página.');
  if (existsSync(join(dist, '_redirects'))) problems.push('dist/_redirects não é esperado (o modo SPA do Pages não usa redirecionamentos).');
  if (existsSync(join(dist, '_routes.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(dist, '_routes.json'), 'utf8'));
      if (JSON.stringify(r.include) !== JSON.stringify(['/api/*', '/o/*']) || (r.exclude ?? []).length) problems.push('dist/_routes.json deve incluir exatamente /api/* e /o/* (as Functions não podem rodar para o resto).');
    } catch { problems.push('dist/_routes.json inválido.'); }
  }
  if (existsSync(join(dist, '_headers'))) {
    const h = readFileSync(join(dist, '_headers'), 'utf8');
    if (!/connect-src 'self';/.test(h)) problems.push("CSP: connect-src deve ser somente 'self' (app e API no mesmo host).");
    if (!/\/admin\n {2}X-Robots-Tag: noindex/.test(h)) problems.push('_headers sem a regra noindex/no-store de /admin.');
  }
  for (const f of ['functions/api/[[path]].ts', 'functions/o/[[path]].ts', 'functions/_shared/proxy.ts']) if (!existsSync(join(root, f))) problems.push(`${f} ausente.`);
  if (existsSync(dist)) {
    for (const f of walk(dist)) {
      if (/(^|\/)(\.env|\.dev\.vars|[^/]*\.sql|[^/]*\.map)$/.test(f)) problems.push(`arquivo que não deve ser publicado: ${f}`);
      if (/\.(js|html|css|json)$/.test(f)) {
        const t = readFileSync(f, 'utf8');
        if (/workers\.dev|localhost:8787|127\.0\.0\.1:8787/.test(t)) problems.push(`${f}: endereço absoluto de Worker/local embutido (o build deve usar VITE_API_URL=same-origin).`);
        if (/\bre_[A-Za-z0-9]{20,}\b|AUTH_SECRET|RESEND_API_KEY/.test(t)) problems.push(`${f}: parece conter segredo.`);
      }
    }
  }
  return problems;
}

function run(cmd, args, env = {}) { execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }); }

function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) { console.error(`Erro: ${parsed.error}\nUso: node scripts/pages.mjs build|check|deploy staging|production [--publish] [--approved-commit SHA40] [--confirm-production dabi-preco-certo]`); return 1; }
  const { command, env, publish, approvedCommit, config } = parsed.plan;
  if (command === 'deploy' && publish) {
    const problems = verifyRelease(process.cwd(), env, approvedCommit);
    if (problems.length) { console.error(`Publicação de ${env} recusada:\n${problems.map(p => `  - ${p}`).join('\n')}`); return 1; }
  }
  console.error(`\n=== pages ${command} ===\n  Ambiente:  ${env}\n  Projeto:   ${config.project}\n  Worker:    ${config.worker} (Service Binding API; configurado no projeto Pages)\n  Endereço:  ${config.url}\n  ${publish ? 'PUBLICA na Cloudflare' : 'Local: nada é enviado à Cloudflare'}\n`);
  if (command === 'build' || command === 'deploy') run('npm', ['run', 'build'], { VITE_API_URL: 'same-origin', VITE_REQUIRE_LOGIN: 'on' }); // anula qualquer .env local
  const problems = validateDist();
  if (problems.length) { console.error(`Validação FALHOU:\n${problems.map(p => `  - ${p}`).join('\n')}`); return 1; }
  console.error('Validação ok (dist, _routes.json, _headers, Functions).');
  if (command === 'deploy' && publish) {
    run('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', config.project, '--branch', config.branch]);
  } else if (command === 'deploy') console.error('Nada foi publicado. Para publicar, repita com --publish.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
