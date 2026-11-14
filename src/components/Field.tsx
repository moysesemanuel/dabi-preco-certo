import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

/** Campo de formulário com o rótulo associado ao controle (leitores de tela anunciam o nome; clicar no rótulo foca o campo). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const generated = useId();
  if (!isValidElement(children)) return <div><label>{label}</label>{children}</div>;
  const control = children as ReactElement<{ id?: string }>;
  const id = control.props.id ?? generated;
  return <div><label htmlFor={id}>{label}</label>{cloneElement(control, { id })}</div>;
}
