import { useState, type FocusEvent, type InputHTMLAttributes } from 'react';
import { formatMoneyInput, parseMoneyInput } from '../domain/moneyInput';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** Controlled currency editor: the draft stays textual; formatting is only a presentation on blur. */
export function MoneyInput({ value, onValueChange, onFocus, onBlur, placeholder = 'R$ 0,00', ...props }: Props) {
  const [focused, setFocused] = useState(false);
  const parsed = parseMoneyInput(value);
  const display = !focused && value !== '' && parsed !== undefined && Number.isFinite(parsed)
    ? formatMoneyInput(parsed)
    : value;

  function handleFocus(event: FocusEvent<HTMLInputElement>) {
    setFocused(true);
    onFocus?.(event);
    if (value !== '') event.currentTarget.select();
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    setFocused(false);
    onBlur?.(event);
  }

  return <input {...props} type="text" inputMode="decimal" placeholder={placeholder} value={display}
    onChange={event => onValueChange(event.target.value)} onFocus={handleFocus} onBlur={handleBlur}
    onClick={event => { if (value !== '') event.currentTarget.select(); }} />;
}
