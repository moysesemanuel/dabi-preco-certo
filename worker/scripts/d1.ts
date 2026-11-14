/** Entrada do CLI de operações do D1 (migrar, exportar, restaurar). Lógica e regras em d1Cli.ts / targets.ts. */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { runD1Cli } from './d1Cli.ts';

process.exitCode = await runD1Cli(process.argv.slice(2), {
  exec: args => { execFileSync('npx', args, { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }); },
  out: l => console.log(l), err: l => console.error(l),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async q => { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } },
});
