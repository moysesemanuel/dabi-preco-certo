// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import './setup';

function Boom(): never { throw new Error('falha inesperada de teste'); }

describe('Rede de segurança contra telas em branco', () => {
  it('uma falha inesperada mostra uma mensagem útil em vez de uma tela em branco', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Seus dados continuam salvos');
    expect(alert.textContent).not.toContain('falha inesperada de teste'); // detalhes técnicos não vão para a tela
    expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeTruthy();
  });
  it('sem falha, mostra o conteúdo normalmente', () => {
    render(<ErrorBoundary><p>conteúdo</p></ErrorBoundary>);
    expect(screen.getByText('conteúdo')).toBeTruthy();
  });
});
