import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Gstr2bUpload } from '../../src/app/(app)/output/taxation/Gstr2bUpload';
import { VerifyRuleForm } from '../../src/app/(app)/output/taxation/VerifyRuleForm';
import { uploadGstr2b, verifyTaxRule } from '../../src/server/gst';

vi.mock('../../src/server/gst', () => ({
  uploadGstr2b: vi.fn(async () => ({
    ok: true,
    data: { id: 'x', period: '062025', invoicesRead: 12, problems: [] },
  })),
  verifyTaxRule: vi.fn(async () => ({ ok: true, data: { ruleId: 'r1' } })),
}));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const PERIOD = { periodFrom: '2025-06-01', periodTo: '2025-06-30' };

describe('Gstr2bUpload', () => {
  it('asks for the JSON file and says why a spreadsheet will not do', () => {
    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    const input = screen.getByLabelText('GSTR-2B JSON');
    expect(input.getAttribute('accept')).toBe('.json,application/json');
    expect(screen.getByText(/not a spreadsheet or a PDF/)).toBeDefined();
  });

  it('names the period it will reconcile against, so the wrong month is visible', () => {
    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    expect(screen.getByText(/2025-06-01 to 2025-06-30/)).toBeDefined();
  });

  it('offers no file input to a role that cannot upload', () => {
    render(<Gstr2bUpload {...PERIOD} readOnly />);
    expect(screen.queryByLabelText('GSTR-2B JSON')).toBeNull();
    expect(screen.getByText(/read the reconciliation but not upload/)).toBeDefined();
  });

  it('sends the file bytes base64-encoded with the period', async () => {
    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    const file = new File(['{"docdata":{}}'], 'gstr2b.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('GSTR-2B JSON'), { target: { files: [file] } });

    await waitFor(() => expect(uploadGstr2b).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(uploadGstr2b).mock.calls[0]![0] as {
      periodFrom: string;
      periodTo: string;
      contentBase64: string;
    };
    expect(arg.periodFrom).toBe('2025-06-01');
    expect(arg.periodTo).toBe('2025-06-30');
    // Decoded, it is the file we handed over, byte for byte.
    expect(atob(arg.contentBase64)).toBe('{"docdata":{}}');
  });

  it('reports how many invoices were read', async () => {
    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    fireEvent.change(screen.getByLabelText('GSTR-2B JSON'), {
      target: { files: [new File(['{}'], 'g.json', { type: 'application/json' })] },
    });
    expect(await screen.findByText(/12 invoices read/)).toBeDefined();
  });

  it('lists the records it could not read rather than dropping them silently', async () => {
    vi.mocked(uploadGstr2b).mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'x',
        period: '062025',
        invoicesRead: 2,
        problems: [{ path: 'docdata.b2b[1].inv[0]', reason: 'no invoice number' }],
      },
    } as never);

    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    fireEvent.change(screen.getByLabelText('GSTR-2B JSON'), {
      target: { files: [new File(['{}'], 'g.json', { type: 'application/json' })] },
    });

    // A dropped invoice is a lost credit, so the file says which ones it lost.
    expect(await screen.findByText('docdata.b2b[1].inv[0]')).toBeDefined();
    expect(screen.getByText(/no invoice number/)).toBeDefined();
    expect(screen.getByText(/silently lost credit/)).toBeDefined();
  });

  it('shows the server’s refusal rather than claiming success', async () => {
    vi.mocked(uploadGstr2b).mockResolvedValueOnce({
      ok: false,
      error: 'That file is for GSTIN 29AAACS1111A1Z7, which is not registered to this company.',
    } as never);

    render(<Gstr2bUpload {...PERIOD} readOnly={false} />);
    fireEvent.change(screen.getByLabelText('GSTR-2B JSON'), {
      target: { files: [new File(['{}'], 'g.json', { type: 'application/json' })] },
    });

    expect(await screen.findByText(/not registered to this company/)).toBeDefined();
    expect(screen.queryByText(/invoices read/)).toBeNull();
  });
});

describe('VerifyRuleForm', () => {
  const OWN = { ruleId: 'r1', ruleLabel: 'Contractor — other than individual', isOwnRule: true };

  it('refuses to offer sign-off on a rule shipped with the product', () => {
    render(<VerifyRuleForm {...OWN} isOwnRule={false} />);
    expect(screen.queryByRole('button', { name: 'Sign off' })).toBeNull();
    expect(screen.getByText(/cannot be signed off for one company only/)).toBeDefined();
  });

  it('asks who is signing off before it will record anything', () => {
    render(<VerifyRuleForm {...OWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByPlaceholderText('Name and membership number')).toBeDefined();
  });

  it('enables confirmation once a name is given', () => {
    render(<VerifyRuleForm {...OWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    const field = screen.getByPlaceholderText('Name and membership number');

    fireEvent.change(field, { target: { value: 'ab' } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field, { target: { value: 'R. Iyer, FCA 201234' } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the rule and the name, so the record has an owner', async () => {
    render(<VerifyRuleForm {...OWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    fireEvent.change(screen.getByPlaceholderText('Name and membership number'), {
      target: { value: 'R. Iyer, FCA 201234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(verifyTaxRule).toHaveBeenCalledWith({
        ruleId: 'r1',
        verifiedBy: 'R. Iyer, FCA 201234',
      }),
    );
  });

  it('keeps the form open and shows the reason when the server refuses', async () => {
    vi.mocked(verifyTaxRule).mockResolvedValueOnce({
      ok: false,
      error: 'That rule does not belong to this company.',
    } as never);

    render(<VerifyRuleForm {...OWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    fireEvent.change(screen.getByPlaceholderText('Name and membership number'), {
      target: { value: 'R. Iyer, FCA 201234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/does not belong to this company/)).toBeDefined();
    // Still open, with the typed name intact — nothing to re-enter.
    expect(
      (screen.getByPlaceholderText('Name and membership number') as HTMLInputElement).value,
    ).toBe('R. Iyer, FCA 201234');
  });

  it('labels the field with the rule it signs off, for a page full of them', () => {
    render(<VerifyRuleForm {...OWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    expect(
      screen.getByLabelText('Who is signing off Contractor — other than individual'),
    ).toBeDefined();
  });
});
