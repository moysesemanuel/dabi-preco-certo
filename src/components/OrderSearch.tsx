import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';

type Props = { value: string; onChange: (v: string) => void };

/**
 * Pesquisa expansível: recolhida parece um botão ("Pesquisar"), aberta vira um campo com lupa, limpar e fechar.
 * Filtra a cada tecla (sem Enter). Fica aberta enquanto houver texto. Esc: limpa o texto; com o campo vazio, fecha.
 */
export function OrderSearch({ value, onChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(value !== '');
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) input.current?.focus();
    if (!open && wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const close = () => { onChange(''); setOpen(false); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (value) { onChange(''); input.current?.focus(); } else setOpen(false);
  };
  if (!open) return <button ref={opener} type="button" className="search-toggle" onClick={() => setOpen(true)} aria-expanded="false" aria-controls={id}><Search size={16} aria-hidden="true" /> Pesquisar</button>;
  return <div id={id} className="search-box" role="search">
    <Search size={16} aria-hidden="true" className="search-icon" />
    <input ref={input} type="search" aria-label="Pesquisar pedidos" placeholder="Código, cliente ou produto..." value={value} onChange={e => onChange(e.target.value)} onKeyDown={onKey} autoComplete="off" enterKeyHint="search" />
    {value && <button type="button" className="search-btn" onClick={() => { onChange(''); input.current?.focus(); }} aria-label="Limpar pesquisa"><X size={14} /></button>}
    <button type="button" className="search-close" onClick={close} aria-label="Fechar pesquisa e mostrar todos os pedidos">Fechar</button>
  </div>;
}
