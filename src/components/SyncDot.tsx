import { useEffect, useId, useRef, useState } from 'react';
import type { IndicatorLevel } from '../account/syncIndicator';

/**
 * Ponto de saúde da sincronização. O texto explicativo aparece em um balão ao passar o mouse, focar (teclado) ou tocar,
 * e também fica no rótulo acessível; não depende do tooltip nativo, que não aparece em toque nem de imediato.
 */
export function SyncDot({ level, label, detail }: { level: IndicatorLevel; label: string; detail: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', esc); document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', away); };
  }, [open]);
  return (
    <span className="sync-wrap" ref={box} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={`sync-dot ${level}`} aria-label={`Sincronização: ${label}. ${detail}`} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={() => setOpen(o => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} />
      {level !== 'ok' && <span className="sync-label" aria-hidden="true">{label}</span>}
      {open && <span role="tooltip" id={id} className="sync-tip"><strong>{label}</strong> {detail}</span>}
    </span>
  );
}
