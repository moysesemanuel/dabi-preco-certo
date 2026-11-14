/**
 * CLI administrativo de licenças (uso local, no ambiente seguro de operação). Não há endpoint público para emitir licenças.
 * O ambiente é SEMPRE explícito: --env local | staging | production (--local é sinônimo de --env local; --remote sozinho é recusado).
 * Cada ambiente usa o seu D1 e o seu `--env` do Wrangler (veja targets.ts). O destino é exibido antes de qualquer operação e
 * revoke / revoke-sessions em produção pedem confirmação adicional. Detalhes e exemplos: worker/README.md.
 *
 * A chave de licença (modo legado) é mostrada UMA vez e nunca vai em linha de comando: o banco recebe só o SHA-256 dela.
 * Requer Node 22.18+ (executa TypeScript) e, para ambientes remotos, as credenciais da Cloudflare do operador.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { runLicensesCli } from './licensesCli.ts';

process.exitCode = await runLicensesCli(process.argv.slice(2), {
  exec: args => execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }),
  out: l => console.log(l), err: l => console.error(l), now: () => new Date(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async q => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } },
});
