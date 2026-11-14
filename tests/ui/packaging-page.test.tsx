// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackagingsPage } from '../../src/pages/PackagingsPage';
import { emptyData } from '../../src/storage/db';

afterEach(cleanup);

describe('PackagingsPage', () => {
  it('cadastra embalagem e apresenta o custo unitário sem arredondamento prematuro', async () => {
    const user = userEvent.setup(); const update = vi.fn(); const inform = vi.fn();
    render(<PackagingsPage data={emptyData()} update={update} inform={inform} focus={() => {}} />);
    await user.type(screen.getByLabelText('Nome'), 'Lacre fino');
    await user.type(screen.getByLabelText('Preço total da compra'), '0,01');
    await user.type(screen.getByLabelText('Quantidade comprada (unidades)'), '200');
    expect(screen.getByText('R$ 0,00005')).toBeTruthy();
    fireEvent.submit(screen.getByLabelText('Nome').closest('form')!);
    expect(update).toHaveBeenCalledOnce();
    const result = update.mock.calls[0][0](emptyData());
    expect(result.packagings[0]).toMatchObject({ name: 'Lacre fino', purchasePrice: 0.01, purchaseQuantity: 200, active: true });
    expect(inform).toHaveBeenCalledWith('Embalagem cadastrada.');
  });
});
