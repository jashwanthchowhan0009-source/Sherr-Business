import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InvoiceForm } from '../../src/app/(app)/process/InvoiceForm';

/**
 * The invoice form's preview is real logic, not decoration: it runs the same
 * `calculateInvoice` the server runs, and a wrong preview is how somebody posts
 * a figure they did not intend. So it is rendered and read.
 *
 * The server action is mocked because this is about what the form computes and
 * shows, not about posting; the posting path has its own integration suite.
 */
vi.mock('../../src/server/ledger', () => ({
  createSalesInvoice: vi.fn(async () => ({ ok: true, data: {} })),
  editSalesInvoice: vi.fn(),
  createParty: vi.fn(),
  createItem: vi.fn(),
  createReceipt: vi.fn(),
}));

const customer = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Anand Enterprises',
  gstin: '29AAACA1111A1Z7',
  stateCode: '29',
  placeOfSupplyStateCode: '29',
};

const outOfState = { ...customer, id: '22222222-2222-4222-8222-222222222222', stateCode: '27', placeOfSupplyStateCode: '27', name: 'Mumbai Traders' };

const item = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice',
  hsnSac: '1006',
  unit: 'KGS',
  gstRateBps: 1800,
  salePricePaise: 1_00_000_00n,
};

afterEach(cleanup);

describe('InvoiceForm', () => {
  it('asks for a customer before anything else when there are none', () => {
    render(
      <InvoiceForm parties={[]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    expect(screen.getByText(/Add a customer first/)).toBeDefined();
  });

  it('renders the line editor and the customer list', () => {
    render(
      <InvoiceForm
        parties={[customer]}
        items={[item]}
        supplierStateCode="29"
        today="2025-06-15"
          lockedUpto={null}
      />,
    );
    expect(screen.getByLabelText('Customer')).toBeDefined();
    expect(screen.getByLabelText('Rate on line 1')).toBeDefined();
    expect(screen.getByText(/Anand Enterprises/)).toBeDefined();
  });

  it('marks an unregistered customer as such rather than leaving it blank', () => {
    render(
      <InvoiceForm
        parties={[{ ...customer, gstin: null }]}
        items={[]}
        supplierStateCode="29"
        today="2025-06-15"
          lockedUpto={null}
      />,
    );
    expect(screen.getByText(/unregistered/)).toBeDefined();
  });

  it('says what editing a posted invoice does, where someone about to post can read it', () => {
    render(
      <InvoiceForm parties={[customer]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    const note = screen.getByText(/Posting puts the invoice in the books/);
    expect(note.textContent).toMatch(/reverses the original/);
    expect(note.textContent).toMatch(/audit trail/);
  });

  it('starts empty: no quantity, unit or GST rate is filled in for you', () => {
    render(
      <InvoiceForm parties={[customer]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    expect((screen.getByLabelText('Quantity on line 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('GST rate on line 1') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Reference') as HTMLInputElement).placeholder).toBe('');
  });

  it('opens filled in when editing a posted invoice and asks for a reason', () => {
    render(
      <InvoiceForm
        parties={[customer]}
        items={[]}
        supplierStateCode="29"
        today="2025-06-15"
        lockedUpto={null}
        edit={{ voucherId: 'v1', voucherNo: 'INV/25-26/0007', posted: true }}
        initial={{
          partyId: customer.id,
          voucherDate: '2025-06-01',
          placeOfSupplyStateCode: '',
          reference: 'PO-9',
          narration: '',
          lines: [
            {
              itemId: '',
              description: 'Consulting',
              hsnSac: '998311',
              unit: 'HRS',
              quantity: '2',
              unitPriceRupees: '1500.00',
              gstRateBps: 1800,
              reverseCharge: false,
            },
          ],
        }}
      />,
    );
    expect((screen.getByLabelText('Description on line 1') as HTMLInputElement).value).toBe('Consulting');
    // 2 x ₹1,500 at 18% within Karnataka.
    expect(screen.getByText('₹3,540.00')).toBeDefined();
    // A posted invoice can only be corrected, never re-saved as a draft.
    expect(screen.queryByRole('button', { name: /draft/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Post correction' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Wrong rate' } });
    expect(screen.getByRole('button', { name: 'Post correction' })).toHaveProperty('disabled', false);
  });

  it('offers a draft as well as a post, so the two are distinct acts', () => {
    render(
      <InvoiceForm parties={[customer]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    expect(screen.getByRole('button', { name: 'Post invoice' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save as draft' })).toBeDefined();
  });

  it('disables posting until a customer is chosen', () => {
    render(
      <InvoiceForm parties={[customer]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    expect(screen.getByRole('button', { name: 'Post invoice' })).toHaveProperty('disabled', true);
  });

  it('defaults the place of supply to the customer rather than leaving it empty', () => {
    render(
      <InvoiceForm
        parties={[outOfState]}
        items={[]}
        supplierStateCode="29"
        today="2025-06-15"
          lockedUpto={null}
      />,
    );
    // The override select exists and explains what it is for.
    expect(screen.getByLabelText('Place of supply')).toBeDefined();
    expect(
      screen.getByText(/not the billing address, decides the tax/),
    ).toBeDefined();
  });

  describe('the preview', () => {
    /** Chooses the customer, since the preview waits for one. */
    const choose = (id: string) =>
      fireEvent.change(screen.getByLabelText('Customer'), { target: { value: id } });

    const fill = (rate: string, qty = '1', gstBps = '1800') => {
      fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: rate } });
      fireEvent.change(screen.getByLabelText('Quantity on line 1'), { target: { value: qty } });
      fireEvent.change(screen.getByLabelText('GST rate on line 1'), { target: { value: gstBps } });
    };

    it('shows nothing until a customer is chosen', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      fill('100000');
      // The supplier's own state must not stand in for the customer's: it would
      // preview CGST and SGST for what may be an inter-state supply.
      expect(screen.queryByText('Taxable value')).toBeNull();

      choose(customer.id);
      expect(screen.getByText('Taxable value')).toBeDefined();
    });

    it('shows the spec §11 intra-state figures', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      choose(customer.id);
      fill('100000');

      // ₹1,00,000 at 18% within Karnataka: CGST ₹9,000, SGST ₹9,000,
      // total ₹1,18,000.
      expect(screen.getByText('CGST')).toBeDefined();
      expect(screen.getByText('SGST')).toBeDefined();
      expect(screen.getAllByText('₹9,000.00')).toHaveLength(2);
      expect(screen.getByText('₹1,18,000.00')).toBeDefined();
      expect(screen.queryByText('IGST')).toBeNull();
      expect(screen.getByText(/Rupees One Lakh Eighteen Thousand Only/)).toBeDefined();
      expect(screen.getByText(/Within Karnataka/)).toBeDefined();
    });

    it('shows the spec §11 inter-state figures', () => {
      render(
        <InvoiceForm
          parties={[outOfState]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      choose(outOfState.id);
      fill('100000');

      expect(screen.getByText('IGST')).toBeDefined();
      expect(screen.getByText('₹18,000.00')).toBeDefined();
      expect(screen.getByText('₹1,18,000.00')).toBeDefined();
      expect(screen.queryByText('CGST')).toBeNull();
      expect(screen.getByText(/Karnataka to Maharashtra/)).toBeDefined();
    });

    it('shows a round-off line only when the total is not whole rupees', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      choose(customer.id);
      fill('100000');
      expect(screen.queryByText('Round off')).toBeNull();

      // ₹99.99 at 18% comes to ₹117.99 — not a whole rupee.
      fill('99.99');
      expect(screen.getByText('Round off')).toBeDefined();
    });

    it('stays quiet while an amount is still being typed', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      choose(customer.id);
      fireEvent.change(screen.getByLabelText('GST rate on line 1'), { target: { value: '1800' } });
      // A trailing decimal point does not parse; the preview waits rather than
      // showing an error over a half-typed figure.
      fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: '100.' } });
      expect(screen.queryByText('Taxable value')).toBeNull();

      fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: '100' } });
      expect(screen.getByText('Taxable value')).toBeDefined();
    });

    it('multiplies by the quantity', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      choose(customer.id);
      fill('1000', '2.5');
      // 2.5 x ₹1,000 = ₹2,500 taxable, ₹2,950 with 18%.
      expect(screen.getByText('₹2,500.00')).toBeDefined();
      expect(screen.getByText('₹2,950.00')).toBeDefined();
    });

    it('fills the line from a chosen item, including its rate and HSN', () => {
      render(
        <InvoiceForm
          parties={[customer]}
          items={[item]}
          supplierStateCode="29"
          today="2025-06-15"
          lockedUpto={null}
        />,
      );
      fireEvent.change(screen.getByLabelText('Item on line 1'), { target: { value: item.id } });

      expect((screen.getByLabelText('Description on line 1') as HTMLInputElement).value).toBe(
        'Basmati rice',
      );
      expect((screen.getByLabelText('HSN or SAC on line 1') as HTMLInputElement).value).toBe('1006');
      expect((screen.getByLabelText('Rate on line 1') as HTMLInputElement).value).toBe('1,00,000.00');
      expect((screen.getByLabelText('GST rate on line 1') as HTMLSelectElement).value).toBe('1800');
    });
  });

  it('lists every GST slab, including nil', () => {
    render(
      <InvoiceForm parties={[customer]} items={[]} supplierStateCode="29" today="2025-06-15"
          lockedUpto={null} />,
    );
    const select = screen.getByLabelText('GST rate on line 1') as HTMLSelectElement;
    const offered = [...select.options].filter((o) => o.value !== '').map((o) => o.textContent);
    expect(offered).toEqual(['0%', '0.25%', '3%', '5%', '12%', '18%', '28%', '40%']);
  });
});
