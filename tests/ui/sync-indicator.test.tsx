// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveIndicator, INDICATOR_TIMING, useStableIndicator, type IndicatorInput } from '../../src/account/syncIndicator';

const base = (o: Partial<IndicatorInput['sync']> = {}, rest: Partial<IndicatorInput> = {}): IndicatorInput => ({
  sync: { phase: 'synced', blocked: null, lastSyncedAt: '2026-11-11T12:30:00.000Z', ...o }, dirty: false, openFinancial: 0, entitled: true, ...rest,
});

describe('deriveIndicator', () => {
  it('verde só com confirmação real e nada pendente', () => {
    expect(deriveIndicator(base()).level).toBe('ok');
    expect(deriveIndicator(base({ phase: 'syncing' })).level).toBe('ok'); // sincronização normal depois de uma confirmação
  });
  it('nunca verde antes da primeira confirmação', () => {
    for (const phase of ['idle', 'syncing', 'synced'] as const) expect(deriveIndicator(base({ phase, lastSyncedAt: undefined })).level).toBe('wait');
  });
  it('não verde com alteração local sem confirmação remota', () => {
    expect(deriveIndicator(base({}, { dirty: true })).level).toBe('wait');
  });
  it('cinza offline e em falha transitória (marcada como falhando)', () => {
    expect(deriveIndicator(base({ phase: 'offline' })).level).toBe('wait');
    const e = deriveIndicator(base({ phase: 'error' })); expect(e.level).toBe('wait'); expect(e.failing).toBe(true);
  });
  it('vermelho para atenção, decisão pendente e recebimentos a reconciliar', () => {
    expect(deriveIndicator(base({ phase: 'attention', message: 'Licença revogada' })).level).toBe('bad');
    expect(deriveIndicator(base({ blocked: 'needs-decision' })).level).toBe('bad');
    expect(deriveIndicator(base({}, { openFinancial: 1 })).level).toBe('bad');
  });
  it('tooltip traz o estado e o horário da última confirmação', () => {
    const t = deriveIndicator(base({ phase: 'offline' })).detail;
    expect(t).toMatch(/Sem conexão/); expect(t).toMatch(/Última sincronização confirmada às \d{2}:\d{2}/);
  });
});

describe('useStableIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const run = (initial: IndicatorInput) => renderHook(({ i }) => { const raw = deriveIndicator(i); return { raw, shown: useStableIndicator(raw) }; }, { initialProps: { i: initial } });

  it('várias sincronizações rápidas não fazem o ponto alternar', () => {
    const { result, rerender } = run(base());
    const seen = new Set<string>([result.current.shown]);
    for (let n = 0; n < 20; n++) {
      rerender({ i: base({ phase: 'syncing' }, { dirty: true }) }); act(() => { vi.advanceTimersByTime(800); }); seen.add(result.current.shown);
      rerender({ i: base() }); act(() => { vi.advanceTimersByTime(300); }); seen.add(result.current.shown);
    }
    expect([...seen]).toEqual(['ok']);
  });
  it('só vira cinza quando a falta de confirmação persiste', () => {
    const { result, rerender } = run(base());
    rerender({ i: base({}, { dirty: true }) });
    act(() => { vi.advanceTimersByTime(INDICATOR_TIMING.toWaitMs - 100); }); expect(result.current.shown).toBe('ok');
    act(() => { vi.advanceTimersByTime(200); }); expect(result.current.shown).toBe('wait');
    rerender({ i: base() }); expect(result.current.shown).toBe('ok');
  });
  it('falha real: cinza e, se persistir, vermelho', () => {
    const { result, rerender } = run(base());
    rerender({ i: base({ phase: 'error' }) });
    act(() => { vi.advanceTimersByTime(INDICATOR_TIMING.toWaitMs + 100); }); expect(result.current.shown).toBe('wait');
    act(() => { vi.advanceTimersByTime(INDICATOR_TIMING.failingToBadMs); }); expect(result.current.shown).toBe('bad');
  });
  it('falha que se recupera rápido nunca chega a vermelho', () => {
    const { result, rerender } = run(base());
    rerender({ i: base({ phase: 'error' }) }); act(() => { vi.advanceTimersByTime(5000); });
    rerender({ i: base() }); act(() => { vi.advanceTimersByTime(60000); });
    expect(result.current.shown).toBe('ok');
  });
  it('exigência de atenção aparece na hora', () => {
    const { result, rerender } = run(base());
    rerender({ i: base({ phase: 'attention', message: 'x' }) }); expect(result.current.shown).toBe('bad');
  });
  it('não mostra verde antes da primeira confirmação', () => {
    const { result } = run(base({ phase: 'syncing', lastSyncedAt: undefined }));
    expect(result.current.shown).toBe('wait');
  });
});
