import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContraForm, JournalForm, PaymentForm, ReverseButton } from '../../src/app/(app)/process/SimpleVoucherForms';
import { PurchaseBillForm } from '../../src/app/(app)/process/PurchaseBillForm';

vi.mock('../../src/server/purchases', () => ({
  createPayment: vi.fn(async () => ({ ok: true, data: { voucherNo: 'PMT/25-26/0001' } })),
  createJournal: vi.fn(async () => ({ ok: true, data: { voucherNo: 'JV/25-26/0001' } })),
  createContra: vi.fn(async () => ({ ok: true, data: { voucherNo: 'CTR/25-26/0001' } })),
  createPurchaseBill: vi.fn(async () => ({
    ok: true,
    data: { voucherNo: 'BILL/25-26/0001', totalPaise: '1180000', posted: true, reverseChargeVoucherNo: null },
  })),
  reverseVoucher: vi.fn(async () => ({ ok: true, data: { voucherNo: 'REV/25-26/0001' } })),
  editPayment: vi.fn(),
  editJournal: vi.fn(),
  editContra: vi.fn(),
  editPurchaseBill: vi.fn(),
}));

const ACCOUNTS = [
  { code: 'RENT', name: 'Rent' },
  { code: 'BANK', name: 'Bank Account' },
  { code: 'SALARIES', name: 'Salaries' },
  { code: 'TDS_PAYABLE', name: 'TDS Payable' },
];

const SUPPLIER = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sunrise Traders',
  gstin: '29AAACS1111A1Z7',
  stateCode: '29',
  placeOfSupplyStateCode: '29',
};

afterEach(cleanup);

describe('JournalForm', () => {
  const setup = () =>
    render(<JournalForm accounts={ACCOUNTS} today="2025-07-15" lockedUpto={null} />);

  const line = (index: number, debit: string, credit: string, account: string) => {
    fireEvent.change(screen.getByLabelText(`Account on line ${index}`), {
      target: { value: account },
    });
    if (debit) {
      fireEvent.change(screen.getByLabelText(`Debit on line ${index}`), {
        target: { value: debit },
      });
    }
    if (credit) {
      fireEvent.change(screen.getByLabelText(`Credit on line ${index}`), {
        target: { value: credit },
      });
    }
  };

  it('starts with two lines, because a journal needs both sides', () => {
    setup();
    expect(screen.getByLabelText('Account on line 1')).toBeDefined();
    expect(screen.getByLabelText('Account on line 2')).toBeDefined();
  });

  it('says nothing is entered before anything is', () => {
    setup();
    expect(screen.getByText('Nothing entered yet.')).toBeDefined();
  });

  it('shows the difference while the entry is out of balance', () => {
    setup();
    line(1, '50000', '', 'RENT');
    line(2, '', '49000', 'BANK');
    // The difference, with which side is short — the information needed to fix
    // it, rather than a bare "unbalanced".
    expect(screen.getByText(/Out by ₹1,000.00/)).toBeDefined();
    expect(screen.getByText(/credit side is short/)).toBeDefined();
  });

  it('names the debit side when that is the short one', () => {
    setup();
    line(1, '49000', '', 'RENT');
    line(2, '', '50000', 'BANK');
    expect(screen.getByText(/debit side is short/)).toBeDefined();
  });

  it('says Balanced once the two sides agree', () => {
    setup();
    line(1, '50000', '', 'RENT');
    line(2, '', '50000', 'BANK');
    expect(screen.getByText('Balanced.')).toBeDefined();
  });

  it('refuses to post while unbalanced', () => {
    setup();
    line(1, '50000', '', 'RENT');
    line(2, '', '49000', 'BANK');
    expect(screen.getByRole('button', { name: 'Post journal' })).toHaveProperty('disabled', true);
  });

  it('refuses to post without a narration, even when balanced', () => {
    setup();
    line(1, '50000', '', 'RENT');
    line(2, '', '50000', 'BANK');
    expect(screen.getByRole('button', { name: 'Post journal' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Narration'), { target: { value: 'Rent for July' } });
    expect(screen.getByRole('button', { name: 'Post journal' })).toHaveProperty('disabled', false);
  });

  it('balances a three-line entry in aggregate', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }));
    line(1, '100000', '', 'SALARIES');
    line(2, '', '10000', 'TDS_PAYABLE');
    line(3, '', '90000', 'BANK');
    expect(screen.getByText('Balanced.')).toBeDefined();
  });

  it('clears the other side when one is typed, so a line cannot carry both', () => {
    setup();
    line(1, '50000', '', 'RENT');
    fireEvent.change(screen.getByLabelText('Credit on line 1'), { target: { value: '50000' } });
    expect((screen.getByLabelText('Debit on line 1') as HTMLInputElement).value).toBe('');
  });

  it('waits rather than erroring on a half-typed figure', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Debit on line 1'), { target: { value: '500.' } });
    expect(screen.getByText('Checking the figures…')).toBeDefined();
  });
});

describe('PurchaseBillForm', () => {
  const setup = (overrides: Partial<Parameters<typeof PurchaseBillForm>[0]> = {}) =>
    render(
      <PurchaseBillForm
        parties={[SUPPLIER]}
        items={[]}
        companyStateCode="29"
        today="2025-07-15"
        lockedUpto={null}
        {...overrides}
      />,
    );

  it("requires the supplier's own invoice number and says why", () => {
    setup();
    const input = screen.getByLabelText('Their invoice number');
    expect(input).toHaveProperty('required', true);
    expect(screen.getByText(/stops the same bill being entered/)).toBeDefined();
  });

  it('will not post without that number', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: SUPPLIER.id } });
    fireEvent.change(screen.getByLabelText('Their invoice date'), { target: { value: '2025-07-14' } });
    fireEvent.change(screen.getByLabelText('Description on line 1'), { target: { value: 'Rice' } });
    fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('GST rate on line 1'), { target: { value: '500' } });
    expect(screen.getByRole('button', { name: 'Post bill' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Their invoice number'), {
      target: { value: 'SUN/001' },
    });
    expect(screen.getByRole('button', { name: 'Post bill' })).toHaveProperty('disabled', false);
  });

  it('starts empty: no supplier date, unit, quantity or GST rate is assumed', () => {
    setup();
    expect((screen.getByLabelText('Their invoice date') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Quantity on line 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('GST rate on line 1') as HTMLSelectElement).value).toBe('');
  });

  it('states that the place of supply is our own state, because we are the recipient', () => {
    setup();
    expect(screen.getByText(/you are the recipient, so the supply is taxed where you are/)).toBeDefined();
  });

  it('offers a reverse-charge marker per line, which the sales form does not', () => {
    setup();
    expect(screen.getByLabelText('Reverse charge on line 1')).toBeDefined();
  });

  it('explains what posting a reverse-charge bill will also do', () => {
    setup();
    fireEvent.click(screen.getByLabelText('Reverse charge on line 1'));
    expect(screen.getByText(/raises that liability as a separate journal/)).toBeDefined();
  });

  it('warns that an unregistered supplier yields no input credit', () => {
    setup({ parties: [{ ...SUPPLIER, gstin: null }] });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: SUPPLIER.id } });
    expect(screen.getByText(/no input tax credit to claim/)).toBeDefined();
  });

  it('shows input tax as an asset in the working', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: SUPPLIER.id } });
    fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: '10000' } });
    // No working until a rate is chosen: none is assumed.
    expect(screen.queryByText(/input credit: an asset, not a liability/)).toBeNull();
    fireEvent.change(screen.getByLabelText('GST rate on line 1'), { target: { value: '1800' } });
    expect(screen.getByText(/input credit: an asset, not a liability/)).toBeDefined();
    expect(screen.getByText('₹11,800.00')).toBeDefined();
  });
});

describe('period locking in the forms', () => {
  it('stops the date field at the day after the lock', () => {
    render(<JournalForm accounts={ACCOUNTS} today="2025-10-15" lockedUpto="2025-09-30" />);
    expect((screen.getByLabelText('Date') as HTMLInputElement).min).toBe('2025-10-01');
    expect(screen.getByText('The books are closed to 2025-09-30.')).toBeDefined();
  });

  it('says it in every form with a date, not only some of them', () => {
    const closed = 'The books are closed to 2025-09-30.';
    for (const form of [
      <ContraForm key="c" today="2025-10-15" lockedUpto="2025-09-30" />,
      <PaymentForm
        key="p"
        parties={[{ id: SUPPLIER.id, name: SUPPLIER.name }]}
        today="2025-10-15"
        lockedUpto="2025-09-30"
      />,
    ]) {
      const { unmount } = render(form);
      expect(screen.getByText(closed)).toBeDefined();
      unmount();
    }
  });

  it('tells the person what is closed', () => {
    render(
      <PurchaseBillForm
        parties={[SUPPLIER]}
        items={[]}
        companyStateCode="29"
        today="2025-10-15"
        lockedUpto="2025-09-30"
      />,
    );
    expect(screen.getByText('The books are closed to 2025-09-30.')).toBeDefined();
  });
});

describe('ContraForm', () => {
  it('offers only the two directions money can move', () => {
    render(<ContraForm today="2025-07-15" lockedUpto={null} />);
    const select = screen.getByLabelText('Move money') as HTMLSelectElement;
    expect([...select.options].filter((o) => o.value).map((o) => o.textContent)).toEqual([
      'From bank to cash',
      'From cash to bank',
    ]);
    // Neither direction is chosen for the person.
    expect(select.value).toBe('');
  });

  it('says why a contra is restricted to cash and bank', () => {
    render(<ContraForm today="2025-07-15" lockedUpto={null} />);
    expect(screen.getByText(/disguised sale/)).toBeDefined();
  });
});

describe('PaymentForm', () => {
  it('asks for a supplier before anything else when there are none', () => {
    render(<PaymentForm parties={[]} today="2025-07-15" lockedUpto={null} />);
    expect(screen.getByText(/Add a supplier before recording a payment/)).toBeDefined();
  });

  it('asks where the money was paid from rather than assuming', () => {
    render(
      <PaymentForm parties={[{ id: SUPPLIER.id, name: SUPPLIER.name }]} today="2025-07-15" lockedUpto={null} />,
    );
    expect((screen.getByLabelText('Paid from') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Amount (₹)') as HTMLInputElement).placeholder).toBe('');
  });

  it('opens filled in when editing, and asks why a posted payment is changing', () => {
    render(
      <PaymentForm
        parties={[{ id: SUPPLIER.id, name: SUPPLIER.name }]}
        today="2025-07-15"
        lockedUpto={null}
        edit={{ voucherId: 'v1', voucherNo: 'PMT/25-26/0003', posted: true }}
        initial={{
          partyId: SUPPLIER.id,
          voucherDate: '2025-07-10',
          amountRupees: '5000.00',
          accountCode: 'CASH',
          reference: 'UTR123',
          narration: '',
        }}
      />,
    );
    expect((screen.getByLabelText('Amount (₹)') as HTMLInputElement).value).toBe('5000.00');
    expect((screen.getByLabelText('Paid from') as HTMLSelectElement).value).toBe('CASH');
    const save = screen.getByRole('button', { name: 'Post correction' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Reason for the change'), {
      target: { value: 'Amount was wrong' },
    });
    expect(screen.getByRole('button', { name: 'Post correction' })).toHaveProperty('disabled', false);
  });
});

describe('ReverseButton', () => {
  it('asks for a reason before it will reverse anything', () => {
    render(<ReverseButton voucherId="abc" voucherNo="INV/25-26/0001" today="2025-10-01" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/why INV\/25-26\/0001 is being reversed/i), {
      target: { value: 'Entered in error' },
    });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveProperty('disabled', false);
  });

  it('can be backed out of without reversing', () => {
    render(<ReverseButton voucherId="abc" voucherNo="INV/25-26/0001" today="2025-10-01" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Reverse' })).toBeDefined();
  });
});
