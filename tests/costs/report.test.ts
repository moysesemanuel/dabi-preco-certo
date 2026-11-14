import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { accountsWithinTarget, FREE_LIMITS, HEAVY, perAccountPerDay, scale, TARGET_SHARE, TYPICAL } from './model';
import { measureProfile, measureStorage } from './profile';

/** `npm run costs`: mede o perfil de consumo (Worker real + SQLite real) e projeta 10/50/100/500 contas com hipóteses explícitas. Só local. */
const run = process.env.COST_REPORT ? it : it.skip;
run('relatório de consumo', async () => {
  const rows = await measureProfile();
  const store = await measureStorage();
  const out: string[] = ['', '== MEDIDO POR AÇÃO (estimativa local; o oficial vem do D1 real) ==',
    ...rows.map(r => `${r.name.padEnd(70)} req=${String(r.requests).padStart(2)}  consultas=${String(r.queries).padStart(3)} (máx ${String(r.maxQueriesPerRequest).padStart(2)}/req)  leituras≈${String(r.rowsRead).padStart(4)}  escritas≈${String(r.rowsWritten).padStart(4)}${r.scans.length ? '  VARREDURA: ' + [...new Set(r.scans)].join(' | ') : ''}`),
    '', `Armazenamento: ≈ ${Math.round(store.bytesPerAccount / 1024)} KiB por conta típica de 60 registros (${store.bytesPerRecord.toFixed(0)} B/registro, medido com ${store.records} registros) → ${Math.floor(FREE_LIMITS.d1StorageBytesPerDatabase * TARGET_SHARE / store.bytesPerAccount)} contas até 50% dos 500 MB do banco gratuito`];
  for (const [label, h] of [['TÍPICO', TYPICAL], ['PESSIMISTA', HEAVY]] as const) {
    const per = perAccountPerDay(rows, h), cap = accountsWithinTarget(per);
    out.push('', `== PROJEÇÃO (${label}) — hipóteses: ${JSON.stringify(h)} ==`, `Por conta ativa/dia: ${per.requests.toFixed(0)} requisições, ≈${per.rowsRead.toFixed(0)} leituras, ≈${per.rowsWritten.toFixed(0)} escritas, ${per.emails.toFixed(2)} e-mails`,
      'contas   requisições/dia (% de 100 mil)   leituras/dia (% de 5 mi)   escritas/dia (% de 100 mil)   e-mails/dia (% de 100)');
    for (const n of [10, 50, 100, 500]) { const r = scale(per, n); out.push(`${String(n).padStart(6)}   ${r.requests.toFixed(0).padStart(9)} (${(r.share.requests * 100).toFixed(1).padStart(5)}%)        ${r.reads.toFixed(0).padStart(9)} (${(r.share.reads * 100).toFixed(2).padStart(5)}%)      ${r.writes.toFixed(0).padStart(8)} (${(r.share.writes * 100).toFixed(1).padStart(5)}%)         ${r.emails.toFixed(1).padStart(6)} (${(r.share.emailsDay * 100).toFixed(1).padStart(5)}%)`); }
    out.push(`Contas ativas até ${TARGET_SHARE * 100}% de cada limite: requisições ${Math.floor(cap.requests)}, leituras ${Math.floor(cap.reads)}, escritas ${Math.floor(cap.writes)}, e-mails ${Math.floor(cap.emails)} → limita: ${cap.limiting} (≈ ${cap.accounts} contas)`);
  }
  process.stdout.write(out.join('\n') + '\n');
  if (process.env.COST_REPORT_FILE) writeFileSync(process.env.COST_REPORT_FILE, out.join('\n') + '\n');
}, 120_000);
