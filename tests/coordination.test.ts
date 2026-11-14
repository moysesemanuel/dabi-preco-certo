import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoordinator, type Role } from '../src/storage/coordination';
import { createFakeBroadcast, createFakeLocks } from './helpers/locks';

// Coordenador de abas com o simulador da Web Locks API (mesma semântica do navegador: exclusivo, fila, steal, liberação ao fechar).
let locks: ReturnType<typeof createFakeLocks>, BC: ReturnType<typeof createFakeBroadcast>;
beforeEach(() => { locks = createFakeLocks(); BC = createFakeBroadcast(); });
afterEach(() => { vi.useRealTimers(); });
const tick = () => new Promise(r => setTimeout(r, 0));
function tab(id: string, withLocks = true) {
  const roles: Role[] = [], saved: number[] = [];
  const c = createCoordinator({ locks: withLocks ? (locks.forTab(id) as never) : null, channel: () => new BC('dabi') as never });
  return { id, c, roles, saved, start: () => c.start({ onRole: r => roles.push(r), onRemoteSaved: v => saved.push(v) }) };
}

describe('Quem edita', () => {
  it('a primeira aba edita; a segunda só consulta', async () => {
    const A = tab('A'), B = tab('B'); A.start(); await tick(); B.start(); await tick();
    expect(A.c.role).toBe('editor'); expect(B.c.role).toBe('viewer'); expect(locks.holder('dabi-preco-certo:editor')).toBe('A');
  });
  it('quando o editor fecha (ou trava), a aba que esperava assume sozinha', async () => {
    const A = tab('A'), B = tab('B'), C = tab('C'); A.start(); await tick(); B.start(); await tick(); C.start(); await tick();
    locks.closeTab('A'); await tick();
    expect(B.c.role).toBe('editor'); expect(C.c.role).toBe('viewer'); // fila: a segunda aba é a próxima, a terceira continua esperando
    locks.closeTab('B'); await tick(); expect(C.c.role).toBe('editor');
  });
  it('"assumir a edição": a aba passa a editar e a anterior vira consulta (e volta à fila)', async () => {
    const A = tab('A'), B = tab('B'); A.start(); await tick(); B.start(); await tick();
    B.c.takeOver(); await tick();
    expect(B.c.role).toBe('editor'); expect(A.c.role).toBe('viewer'); expect(A.roles).toEqual(['editor', 'viewer']);
    B.c.stop(); await new Promise(r => setTimeout(r, 80)); await tick();
    expect(A.c.role).toBe('editor'); // quem foi substituído assume de novo quando o novo editor sai
  });
  it('assumir várias vezes seguidas não duplica esperas nem gera dois editores', async () => {
    const A = tab('A'), B = tab('B'); A.start(); await tick(); B.start(); await tick();
    for (let i = 0; i < 4; i++) { B.c.takeOver(); await tick(); A.c.takeOver(); await tick(); }
    const editors = [A, B].filter(t => t.c.role === 'editor'); expect(editors).toHaveLength(1);
    expect(locks.holder('dabi-preco-certo:editor')).toBe(editors[0].id);
  });
  it('remontagem imediata (StrictMode) não perde o bloqueio; sair de verdade solta depois de um instante', async () => {
    vi.useFakeTimers(); const A = tab('A'), B = tab('B');
    A.start(); await vi.advanceTimersByTimeAsync(1); A.c.stop(); A.start(); await vi.advanceTimersByTimeAsync(200); // desmonta e monta de novo
    B.start(); await vi.advanceTimersByTimeAsync(1);
    expect(A.c.role).toBe('editor'); expect(B.c.role).toBe('viewer');
    A.c.stop(); await vi.advanceTimersByTimeAsync(200); expect(B.c.role).toBe('editor');
  });
  it('sem Web Locks (navegador antigo): a aba segue como editora e `supported` é falso (a rede de segurança é a versão do documento)', async () => {
    const A = tab('A', false); A.start(); expect(A.c.supported).toBe(false); expect(A.c.role).toBe('editor');
  });
});

describe('Avisos entre abas (sem rede)', () => {
  it('quem grava avisa as OUTRAS abas, nunca a si mesma', async () => {
    const A = tab('A'), B = tab('B'); A.start(); B.start(); await tick();
    A.c.notifySaved(7); await tick(); expect(B.saved).toEqual([7]); expect(A.saved).toEqual([]);
  });
  it('sem BroadcastChannel nada quebra (a aba em consulta relê ao voltar o foco)', async () => {
    const c = createCoordinator({ locks: locks.forTab('A') as never, channel: () => undefined });
    c.start({ onRole: () => undefined, onRemoteSaved: () => undefined }); await tick(); expect(() => c.notifySaved(1)).not.toThrow();
  });
});
