import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../utils';

/** Código permanente de atendimento, discreto, com ação de copiar e confirmação acessível ("Copiado"). */
export function QuoteCode({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(code);
    setState(ok ? 'copied' : 'failed'); clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return <div className="quote-code">
    <span className="quote-code-text" aria-label={`Código do orçamento ${code}`}>{code}</span>
    <button type="button" className="quote-code-copy" onClick={() => void copy()} aria-label={`Copiar código ${code}`} title="Copiar código">{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>
    <span className="quote-code-status" role="status" aria-live="polite">{state === 'copied' ? 'Copiado' : state === 'failed' ? 'Não foi possível copiar' : ''}</span>
  </div>;
}
