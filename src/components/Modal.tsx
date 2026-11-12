import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Janela de diálogo acessível: foco preso dentro dela, Esc fecha ("decidir depois"), o foco volta a quem abriu e a página
 * atrás fica inerte para leitores de tela. Em telas pequenas ocupa a largura toda.
 */
export function Modal({ title, titleId, onClose, children }: { title: ReactNode; titleId: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      else if (!box.current.contains(document.activeElement)) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; opener?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
      <div className="modal-head"><h2 id={titleId}>{title}</h2><button type="button" className="secondary" onClick={onClose} aria-label="Fechar e decidir depois">Fechar</button></div>
      {children}
    </div>
  </div>;
}
