// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/components/Sidebar';

describe('menu lateral', () => {
  it('recolhe para ícones com favicon e pode ser expandido novamente', () => {
    render(<Sidebar activePage="dashboard" onNavigate={vi.fn()} />);
    const sidebar = screen.getByRole('complementary');
    const nav = within(screen.getByRole('navigation', { name: 'Navegação principal' }));

    expect(screen.getByRole('img', { name: 'Custô' }).getAttribute('src')).toBe('/brand/custo-color.svg');
    const collapse = screen.getByRole('button', { name: 'Recolher menu' });
    expect(collapse.querySelector('svg')?.classList.contains('lucide-chevron-left')).toBe(true);
    fireEvent.click(collapse);

    expect(sidebar.classList.contains('is-collapsed')).toBe(true);
    expect(document.querySelector('.brand-logo-icon')?.getAttribute('src')).toBe('/brand/favicon-custo-color.svg');
    const expand = screen.getByRole('button', { name: 'Expandir menu' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(expand.querySelector('svg')?.classList.contains('lucide-chevron-right')).toBe(true);
    expect(nav.getByRole('button', { name: 'Agenda' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expandir menu' }));
    expect(sidebar.classList.contains('is-collapsed')).toBe(false);
    expect(document.querySelector('.brand-logo-full')?.getAttribute('src')).toBe('/brand/custo-color.svg');
  });
});
