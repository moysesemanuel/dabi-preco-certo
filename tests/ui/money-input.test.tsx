// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoneyInput } from '../../src/components/MoneyInput';

afterEach(cleanup);

function Controlled({ initial = '', onChange = vi.fn() }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <MoneyInput aria-label="Preço" value={value} onValueChange={next => { setValue(next); onChange(next); }} />;
}

describe('MoneyInput', () => {
  it('mostra placeholder sem preencher valor e permite digitar ao focar', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled onChange={changed} />);
    const input = screen.getByRole('textbox', { name: 'Preço' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(input.getAttribute('placeholder')).toBe('R$ 0,00');
    await user.click(input);
    await user.type(input, '25,90');
    expect((input as HTMLInputElement).value).toBe('25,90');
    expect(changed).toHaveBeenLastCalledWith('25,90');
  });

  it('mantém valor existente ao focar, seleciona para substituição e formata em pt-BR no blur', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="1234.56" onChange={changed} />);
    const input = screen.getByRole('textbox', { name: 'Preço' }) as HTMLInputElement;
    expect(input.value).toBe('1.234,56');
    await user.click(input);
    expect(input.value).toBe('1234.56');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await user.type(input, '25,90');
    expect(input.value).toBe('25,90');
    fireEvent.blur(input);
    expect(input.value).toBe('25,90');
  });

  it('aceita colagem localizada e deixa um campo apagado vazio no blur', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="" onChange={changed} />);
    const input = screen.getByRole('textbox', { name: 'Preço' });
    await user.click(input);
    await user.paste('R$ 1.234,56');
    expect((input as HTMLInputElement).value).toBe('R$ 1.234,56');
    expect(changed).toHaveBeenLastCalledWith('R$ 1.234,56');
    await user.clear(input);
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('');
  });
});
