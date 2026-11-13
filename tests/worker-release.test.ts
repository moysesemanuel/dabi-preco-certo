import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWorkerArgs, workerDeployArgs } from '../scripts/worker.mjs';

describe('publicação reproduzível do Worker staging', () => {
  const sha = 'c'.repeat(40);

  it('exige ambiente e revisão explícitos para qualquer publicação', () => {
    expect(parseWorkerArgs(['deploy']).ok).toBe(false);
    expect(parseWorkerArgs(['deploy', 'production', '--publish', '--approved-commit', sha]).ok).toBe(false);
    expect(parseWorkerArgs(['deploy', 'staging', '--publish']).ok).toBe(false);
    expect(parseWorkerArgs(['deploy', 'staging', '--publish', '--approved-commit', 'abc']).ok).toBe(false);
    expect(parseWorkerArgs(['deploy', 'staging', '--publish', '--approved-commit', sha]))
      .toMatchObject({ ok: true, plan: { env: 'staging', publish: true, approvedCommit: sha } });
  });

  it('registra o mesmo SHA como mensagem e tag da versão do Worker', () => {
    expect(workerDeployArgs(sha)).toEqual([
      'deploy', '--env', 'staging', '--config', 'worker/wrangler.toml',
      '--message', `Custô staging release ${sha}`, '--tag', sha, '--strict',
    ]);
  });

  it('altera apenas o nome visível do remetente de staging e preserva o endereço verificado', () => {
    const config = readFileSync('worker/wrangler.toml', 'utf8');
    const staging = config.split('[env.staging.vars]')[1]?.split('\n[')[0] ?? '';
    const sender = staging.match(/^EMAIL_FROM\s*=\s*"([^"]+)"/m)?.[1];
    expect(sender).toBe('Custô <acesso@mail.dabitech.com.br>');
  });
});
