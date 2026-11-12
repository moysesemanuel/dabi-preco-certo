import { useEffect, useRef, useState } from 'react';
import type { SyncState } from './AccountContext';

/** ok = verde (saudável) · wait = cinza (offline, pendência ou sem confirmação) · conflict = âmbar (conflito aguardando decisão) · bad = vermelho (falha/atenção). */
export type IndicatorLevel = 'ok' | 'wait' | 'conflict' | 'bad';
export type IndicatorInput = {
  sync: SyncState;
  /** Há alteração local ainda sem confirmação remota (diferença para a última versão confirmada pelo servidor). */
  hasPending: boolean;
  /** Conflitos aguardando decisão (dados e recebimentos). Nunca é mascarado por uma sincronização bem-sucedida de outros registros. */
  conflicts: number;
  entitled: boolean;
  /** `navigator.onLine`: false = o navegador sabe que está sem rede. Padrão: online. */
  browserOnline?: boolean;
};
export type Indicator = { level: IndicatorLevel; label: string; detail: string; /** falha que só vira vermelha se persistir */ failing: boolean };

/** Tempos de estabilização: o indicador não reage a cada requisição. */
export const INDICATOR_TIMING = { toWaitMs: 6000, failingToBadMs: 20000 };

export const formatSyncTime = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Deriva a saúde da sincronização SOMENTE dos estados existentes. Verde exige: uma confirmação remota real (`lastSyncedAt`),
 * nenhuma falha em andamento e nenhuma alteração local pendente. Nada aqui inventa sucesso.
 */
export function deriveIndicator({ sync, hasPending, conflicts, entitled, browserOnline = true }: IndicatorInput): Indicator {
  const last = formatSyncTime(sync.lastSyncedAt);
  const lastText = last ? ` Última confirmação do servidor às ${last}.` : ' Ainda não houve confirmação do servidor nesta sessão.';
  const saved = hasPending ? ' Suas alterações estão salvas neste dispositivo, mas ainda não foram confirmadas pelo servidor.' : '';
  if (!entitled) return { level: 'wait', label: 'Sem sincronização', detail: 'A sincronização não está ativa para esta conta.', failing: false };
  if (sync.blocked) return { level: 'bad', label: 'Precisa da sua decisão', detail: `A sincronização precisa da sua decisão em Configurações. Nada foi enviado ainda.${lastText}`, failing: false };
  if (conflicts > 0) return { level: 'conflict', label: conflicts === 1 ? 'Conflito aguardando decisão' : `${conflicts} conflitos aguardando decisão`, detail: `${conflicts === 1 ? 'Um registro foi alterado aqui e em outro dispositivo.' : `${conflicts} registros foram alterados aqui e em outro dispositivo.`} As duas versões estão preservadas; nada foi sobrescrito. Escolha qual manter em "Acessar conflitos".${saved}${lastText}`, failing: false };
  if (sync.phase === 'attention') return { level: 'bad', label: 'Precisa de atenção', detail: `${sync.message ?? 'A sincronização precisa de atenção.'}${saved}${lastText}`, failing: false };
  if (sync.phase === 'offline' || !browserOnline) {
    // Sem rede conhecida pelo navegador é uma condição normal (cinza). Servidor inalcançável com o navegador "online" é falha: vira vermelha se persistir.
    const serverDown = browserOnline && sync.phase === 'offline';
    return { level: 'wait', label: serverDown ? 'Servidor inacessível' : 'Sem conexão', detail: `${serverDown ? 'Não foi possível falar com o servidor; novas tentativas são automáticas.' : 'Sem conexão: a sincronização é retomada sozinha quando a internet voltar.'}${saved}${lastText}`, failing: serverDown };
  }
  if (sync.phase === 'error') return { level: 'wait', label: 'Falha ao sincronizar', detail: `Não foi possível sincronizar; novas tentativas são automáticas.${saved}${lastText}`, failing: true };
  if (!sync.lastSyncedAt) return { level: 'wait', label: 'Aguardando confirmação', detail: 'Ainda não houve confirmação do servidor nesta sessão. Suas alterações ficam salvas neste dispositivo.', failing: false };
  if (sync.failingSince) return { level: 'wait', label: 'Reconfirmando', detail: `Confirmando de novo com o servidor depois de uma falha.${saved}${lastText}`, failing: true };
  if (hasPending) return { level: 'wait', label: 'Alterações a enviar', detail: `Há alterações neste dispositivo ainda sem confirmação do servidor.${lastText}`, failing: false };
  return { level: 'ok', label: 'Sincronizado', detail: `Sincronização em dia.${lastText}`, failing: false };
}

/**
 * Estabiliza o nível exibido: melhora (→ verde) e exigência de atenção (→ vermelho) aparecem na hora; piora para cinza só
 * depois de `toWaitMs` contínuos, então sincronizações rápidas e repetidas não fazem o ponto alternar. Falha só vira
 * vermelha se persistir por `failingToBadMs`.
 */
export function useStableIndicator(raw: Indicator): IndicatorLevel {
  const [shown, setShown] = useState<IndicatorLevel>(raw.level);
  const shownRef = useRef(shown); shownRef.current = shown;
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (raw.level === 'ok' || raw.level === 'bad' || raw.level === 'conflict') setShown(raw.level);
    else {
      if (shownRef.current !== 'wait') timers.push(setTimeout(() => setShown('wait'), INDICATOR_TIMING.toWaitMs));
      if (raw.failing) timers.push(setTimeout(() => setShown('bad'), INDICATOR_TIMING.failingToBadMs));
    }
    return () => timers.forEach(clearTimeout);
  }, [raw.level, raw.failing]);
  return shown;
}

/** Acompanha `navigator.onLine` (eventos online/offline). */
export function useBrowserOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}
