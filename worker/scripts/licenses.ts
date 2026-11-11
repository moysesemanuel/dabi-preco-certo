/**
 * CLI administrativo de licenças (uso local, no ambiente seguro de operação). Não há endpoint público para emitir licenças.
 *
 *   npm run licenses -- issue  --local|--remote [--email comprador@exemplo.com] [--label "Pedido 123"] [--quota-active 100] [--quota-daily 30]
 *   npm run licenses -- bind <lic_id> --email comprador@exemplo.com --local|--remote   (vincula uma licença existente a uma conta)
 *   npm run licenses -- revoke-sessions <lic_id> --local|--remote   (encerra os dispositivos da conta, sem revogar a licença)
 *   npm run licenses -- status <lic_id> --local|--remote
 *   npm run licenses -- list --local|--remote
 *   npm run licenses -- revoke <lic_id> --local|--remote [--revoke-quotes]
 *   npm run licenses -- activate <lic_id> --local|--remote
 *
 * `--local` usa o D1 de desenvolvimento. `--remote` escreve no banco de produção e exige as credenciais da Cloudflare
 * (CLOUDFLARE_API_TOKEN ou `wrangler login`) do operador: sem elas, nada é emitido. A chave é gerada aqui, mostrada UMA vez
 * e nunca é gravada nem passada em linha de comando: o banco recebe somente o SHA-256 dela. Requer Node 22.18+ (executa TypeScript).
 */
import { execFileSync } from 'node:child_process';
import { generateLicenseId, generateLicenseKey, hashLicenseKey } from '../src/licenses.ts';
import { bindLicenseEmailSql, issueLicenseSql, licenseStatusSql, listLicensesSql, revokeLicenseQuotesSql, revokeLicenseSessionsSql, setLicenseStatusSql } from '../src/licenseAdmin.ts';

const DB_NAME = 'dabi-orcamentos';
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VALUE_OPTIONS = new Set(['--label', '--quota-active', '--quota-daily', '--email']);
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUE_OPTIONS.has(argv[i])) { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const [command, licenseId] = positional;

function fail(message: string): never { console.error(`Erro: ${message}`); process.exit(1); }
if (flag('--local') === flag('--remote')) fail('informe exatamente um destino: --local ou --remote.');
const remote = flag('--remote');

function d1(sql: string): Record<string, unknown>[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--config', 'worker/wrangler.toml', remote ? '--remote' : '--local', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}
const nowIso = () => new Date().toISOString();
const dayStart = () => `${new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)}T03:00:00.000Z`;
const show = (rows: Record<string, unknown>[]) => console.table(rows.map(r => ({ id: r.id, rótulo: r.label, 'e-mail': r.email, status: r.status, dispositivos: r.active_sessions, 'ativos/cota': `${r.active_quotes}/${r.quota_active}`, 'hoje/cota': `${r.created_today}/${r.quota_daily}`, criada: r.created_at, revogada: r.revoked_at })));

try {
  if (remote) console.error('ATENÇÃO: operando no banco REMOTO (produção).');
  if (command === 'issue') {
    const key = generateLicenseKey();
    const id = generateLicenseId();
    const email = option('--email');
    d1(issueLicenseSql({ id, keyHash: await hashLicenseKey(key), label: option('--label'), email, quotaActive: Number(option('--quota-active') ?? 100), quotaDaily: Number(option('--quota-daily') ?? 30), now: nowIso() }));
    if (email) {
      // Licença de CONTA: o comprador entra por código enviado ao e-mail. A chave gerada é descartada (nunca é exibida nem usada).
      console.log(`\nLicença de conta emitida.\n  Proprietário (ID interno): ${id}\n  E-mail do comprador: ${email}\n  Destino: ${remote ? 'REMOTO' : 'local'}\n\nO comprador acessa com o código enviado a esse e-mail (2 dispositivos).`);
    } else {
      console.log(`\nLicença emitida (modo chave legado).\n  Proprietário (ID interno): ${id}\n  Destino: ${remote ? 'REMOTO' : 'local'}\n\n  CHAVE (exibida somente agora; não é possível recuperá-la depois):\n\n    ${key}\n\nEntregue a chave ao comprador por um canal seguro. A chave só funciona com LEGACY_KEY_AUTH=on; prefira licenças de conta (--email).`);
    }
  } else if (command === 'status' && licenseId) {
    const rows = d1(licenseStatusSql(licenseId, dayStart()));
    if (!rows.length) fail('licença não encontrada.');
    show(rows);
  } else if (command === 'list') {
    show(d1(listLicensesSql(dayStart())));
  } else if (command === 'revoke' && licenseId) {
    d1(setLicenseStatusSql(licenseId, 'revoked', nowIso()));
    d1(revokeLicenseSessionsSql(licenseId, nowIso()));
    if (flag('--revoke-quotes')) d1(revokeLicenseQuotesSql(licenseId, nowIso()));
    console.log(`Licença ${licenseId} revogada${flag('--revoke-quotes') ? ' e seus orçamentos ativos foram retirados do ar' : ' (os orçamentos já publicados continuam acessíveis)'}.`);
  } else if (command === 'bind' && licenseId && option('--email')) {
    d1(bindLicenseEmailSql(licenseId, option('--email') as string));
    console.log(`Licença ${licenseId} vinculada a ${option('--email')} (apenas se ainda não tinha e-mail).`);
  } else if (command === 'revoke-sessions' && licenseId) {
    d1(revokeLicenseSessionsSql(licenseId, nowIso()));
    console.log(`Dispositivos da conta da licença ${licenseId} desconectados.`);
  } else if (command === 'activate' && licenseId) {
    d1(setLicenseStatusSql(licenseId, 'active', nowIso()));
    console.log(`Licença ${licenseId} reativada.`);
  } else {
    fail('comando inválido. Use: issue | bind <id> --email | status <id> | list | revoke <id> [--revoke-quotes] | revoke-sessions <id> | activate <id>, com --local ou --remote.');
  }
} catch (error) {
  // Nunca imprime o comando executado nem a chave; só a mensagem.
  fail(error instanceof Error ? error.message.split('\n')[0] : 'falha inesperada.');
}
