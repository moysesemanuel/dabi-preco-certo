import { beforeAll, describe, expect, it } from 'vitest';
import { accountsWithinTarget, FREE_LIMITS, HEAVY, perAccountPerDay, TYPICAL } from './model';
import { measureProfile, type Measured } from './profile';

/**
 * Orçamentos de consumo (regressão). Se um destes testes falhar, uma mudança aumentou o consumo de requisições ou do D1:
 * avalie o impacto na política de custo zero (docs/POLITICA_DE_CUSTOS.md) antes de ajustar o número.
 */
let rows: Measured[];
beforeAll(async () => { rows = await measureProfile(); }, 60_000);
const row = (start: string) => rows.find(r => r.name.startsWith(start))!;

describe('Orçamentos por ação', () => {
  it('nenhuma requisição chega perto do limite gratuito de 50 consultas D1 por invocação (metade, no máximo 25)', () => {
    for (const r of rows) expect(r.maxQueriesPerRequest, r.name).toBeLessThanOrEqual(FREE_LIMITS.d1QueriesPerInvocation / 2);
  });
  it('nenhuma consulta quente varre uma tabela inteira (todas usam índice/chave)', () => { for (const r of rows) expect(r.scans, r.name).toEqual([]); });
  it('sincronização sem mudanças: 1 requisição, ≤ 9 consultas com o pull do catálogo, ≤ 1 escrita', () => {
    const r = row('Sincronização sem mudanças'); expect(r.requests).toBe(1); expect(r.queries).toBeLessThanOrEqual(9); expect(r.rowsWritten).toBeLessThanOrEqual(1);
  });
  it('abrir o app já logado custa só 3 consultas de leitura', () => { const r = row('Abrir o app'); expect(r.queries).toBe(3); expect(r.rowsWritten).toBe(0); });
  it('editar e sincronizar: 3 requisições (pull + push + pull de confirmação), poucas escritas', () => {
    const r = row('Editar 1 ingrediente'); expect(r.requests).toBe(3); expect(r.rowsWritten).toBeLessThanOrEqual(8); expect(r.rowsRead).toBeLessThanOrEqual(80);
  });
  it('abrir um link público: 1 consulta e nenhuma escrita', () => { const r = row('Cliente abre'); expect(r.queries).toBe(1); expect(r.rowsWritten).toBe(0); expect(r.requests).toBe(1); });
  it('login: poucas consultas (acontece raramente graças às sessões de 30 dias)', () => { const r = row('Login'); expect(r.queries).toBeLessThanOrEqual(30); expect(r.rowsWritten).toBeLessThanOrEqual(22); });
  it('baixar a conta inteira (60 registros) cabe em ≤ 12 consultas', () => { expect(row('Outro aparelho baixa').queries).toBeLessThanOrEqual(12); });
});

describe('Projeção (hipóteses explícitas; NÃO é capacidade garantida)', () => {
  it('o uso típico de 100 contas ativas cabe com folga nos limites gratuitos diários', () => {
    const per = perAccountPerDay(rows, TYPICAL);
    expect(per.requests * 100).toBeLessThan(FREE_LIMITS.workerRequestsPerDay * 0.5);
    expect(per.rowsWritten * 100).toBeLessThan(FREE_LIMITS.d1RowsWrittenPerDay * 0.5);
    expect(per.rowsRead * 100).toBeLessThan(FREE_LIMITS.d1RowsReadPerDay * 0.1);
    expect(per.emails * 500).toBeLessThan(FREE_LIMITS.resendEmailsPerDay * 0.5); // logins são raros: o Resend não é o gargalo
  });
  it('o gargalo é a escrita no D1 (e não as leituras nem o Resend), em qualquer cenário', () => {
    for (const h of [TYPICAL, HEAVY]) expect(accountsWithinTarget(perAccountPerDay(rows, h)).limiting).toBe('writes');
  });
});
