import { useEffect, useRef, useState } from 'react';
import type { SyncState } from './AccountContext';

/** ok = verde (saudável) · wait = cinza (offline ou sem confirmação) · bad = vermelho (exige atenção). */
export type IndicatorLevel = 'ok' | 'wait' | 'bad';
export type IndicatorInput = {
  sync: SyncState;
  /** Há alteração local ainda sem confirmação remota. */
  dirty: boolean;
  openFinancial: number;
  entitled: boolean;
};
export type Indicator = { level: IndicatorLevel; label: string; detail: string; /** falha de rede/servidor que só vira vermelha se persistir */ failing: boolean };

/** Tempos de estabilização: o indicador não reage a cada requisição. */
export const INDICATOR_TIMING = { toWaitMs: 6000, failingToBadMs: 20000 };

export const formatSyncTime = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Deriva a saúde da sincronização SOMENTE dos estados existentes. Verde exige uma confirmação real do servidor
 * (`lastSyncedAt`) e nenhuma alteração local pendente. Nada aqui inventa sucesso.
 */
export function deriveIndicator({ sync, dirty, openFinancial, entitled }: IndicatorInput): Indicator {
  const last = formatSyncTime(sync.lastSyncedAt);
  const lastText = last ? ` Última sincronização confirmada às ${last}.` : '';
  if (!entitled) return { level: 'wait', label: 'Sem sincronização', detail: 'A sincronização não está ativa para esta conta.', failing: false };
  if (sync.blocked) return { level: 'bad', label: 'Precisa da sua decisão', detail: `A sincronização precisa da sua decisão em Configurações. Nada foi enviado ainda.${lastText}`, failing: false };
  if (openFinancial > 0) return { level: 'bad', label: 'Recebimentos a reconciliar', detail: `Há recebimentos aguardando a sua reconciliação (veja em Configurações).${lastText}`, failing: false };
  switch (sync.phase) {
    case 'attention': return { level: 'bad', label: 'Precisa de atenção', detail: `${sync.message ?? 'A sincronização precisa de atenção.'}${lastText}`, failing: false };
    case 'error': return { level: 'wait', label: 'Falha ao sincronizar', detail: `Não foi possível sincronizar. Suas alterações estão salvas neste dispositivo e serão reenviadas.${lastText}`, failing: true };
    case 'offline': return { level: 'wait', label: 'Sem conexão', detail: `Sem conexão: as alterações ficam neste dispositivo e serão enviadas depois.${lastText}`, failing: false };
    case 'idle': return { level: 'wait', label: 'Aguardando confirmação', detail: 'Ainda não houve confirmação de sincronização nesta sessão.', failing: false };
    case 'syncing':
    case 'synced':
      if (!sync.lastSyncedAt) return { level: 'wait', label: 'Aguardando confirmação', detail: 'Ainda não houve confirmação de sincronização nesta sessão.', failing: false };
      if (dirty) return { level: 'wait', label: 'Alterações a enviar', detail: `Há alterações neste dispositivo ainda sem confirmação do servidor.${lastText}`, failing: false };
      return { level: 'ok', label: 'Sincronizado', detail: `Sincronização em dia.${lastText}`, failing: false };
  }
}

/**
 * Estabiliza o nível exibido: melhora (→ verde) e exigência de atenção (→ vermelho) aparecem na hora; piora para cinza só
 * depois de `toWaitMs` contínuos, então sincronizações rápidas e repetidas não fazem o ponto alternar. Falha de rede
 * só vira vermelha se persistir por `failingToBadMs`.
 */
export function useStableIndicator(raw: Indicator): IndicatorLevel {
  const [shown, setShown] = useState<IndicatorLevel>(raw.level);
  const shownRef = useRef(shown); shownRef.current = shown;
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (raw.level === 'ok' || raw.level === 'bad') setShown(raw.level);
    else {
      if (shownRef.current !== 'wait') timers.push(setTimeout(() => setShown('wait'), INDICATOR_TIMING.toWaitMs));
      if (raw.failing) timers.push(setTimeout(() => setShown('bad'), INDICATOR_TIMING.failingToBadMs));
    }
    return () => timers.forEach(clearTimeout);
  }, [raw.level, raw.failing]);
  return shown;
}
