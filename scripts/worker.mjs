// Publicação explícita e reproduzível do Worker de staging.
// Exige o SHA aprovado e um checkout limpo antes de executar o Wrangler.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verifyStagingRelease } from './pages.mjs';

export function parseWorkerArgs(argv) {
  const [command, env, ...rest] = argv;
  if (command !== 'deploy') return { ok: false, error: 'comando inválido (deploy).' };
  if (env !== 'staging') return { ok: false, error: 'informe staging; este script não publica em produção.' };
  let publish = false, approvedCommit;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--publish') publish = true;
    else if (rest[i] === '--approved-commit') approvedCommit = rest[++i];
    else return { ok: false, error: `opção desconhecida: ${rest[i]}` };
  }
  if (approvedCommit !== undefined && !publish) return { ok: false, error: '--approved-commit só se aplica a uma publicação.' };
  if (publish && !/^[0-9a-f]{40}$/i.test(approvedCommit ?? '')) return { ok: false, error: 'publicar em staging exige --approved-commit com o SHA completo de 40 caracteres.' };
  return { ok: true, plan: { command, env, publish, approvedCommit } };
}

export const workerDeployArgs = approvedCommit => [
  'deploy', '--env', 'staging', '--config', 'worker/wrangler.toml',
  '--message', `Custô staging release ${approvedCommit}`, '--tag', approvedCommit, '--strict',
];

function main(argv) {
  const parsed = parseWorkerArgs(argv);
  if (!parsed.ok) { console.error(`Erro: ${parsed.error}\nUso: node scripts/worker.mjs deploy staging --publish --approved-commit SHA40`); return 1; }
  const { publish, approvedCommit } = parsed.plan;
  if (!publish) { console.error('Nada foi publicado. Para publicar, informe --publish e o SHA completo aprovado.'); return 0; }
  const problems = verifyStagingRelease(process.cwd(), approvedCommit);
  if (problems.length) { console.error(`Publicação do Worker staging recusada:\n${problems.map(p => `  - ${p}`).join('\n')}`); return 1; }
  console.error(`Worker: dabi-orcamentos-staging\nCommit aprovado: ${approvedCommit}\nCheckout limpo confirmado.`);
  try { execFileSync('npx', ['wrangler', ...workerDeployArgs(approvedCommit)], { stdio: 'inherit' }); return 0; }
  catch { console.error('O Wrangler não concluiu a publicação do Worker staging.'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
