import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MetricCards, type Metric } from '../../src/app/(app)/dashboard/MetricCards';

/**
 * The cards and the drawer behind them.
 *
 * The drawer is not a convenience: the claim this product makes is that a number
 * can be followed back to the document it came from, and this is where that
 * claim is either kept or broken.
 */

const withTrace: Metric = {
  key: 'receivable',
  label: 'Customers owe',
  valuePaise: '12980000', // ₹1,29,800
  caption: '₹1,18,000 of it is overdue.',
  status: 'verified',
  statusReason: 'Agrees with the Sundry Debtors control account.',
  trace: [
    {
      voucherId: 'v1',
      voucherNo: 'INV/25-26/0001',
      voucherType: 'sales',
      voucherDate: '2025-05-01',
      partyName: 'Anand Enterprises',
      amountPaise: '5900000',
      hasDocument: true,
    },
    {
      voucherId: 'v2',
      voucherNo: 'INV/25-26/0002',
      voucherType: 'sales',
      voucherDate: '2025-06-01',
      partyName: 'Anand Enterprises',
      amountPaise: '5900000',
      hasDocument: false,
    },
    {
      voucherId: 'v3',
      voucherNo: 'INV/25-26/0003',
      voucherType: 'sales',
      voucherDate: '2025-06-15',
      partyName: 'Anand Enterprises',
      amountPaise: '1180000',
      hasDocument: false,
    },
  ],
};

const withoutTrace: Metric = {
  key: 'cash',
  label: 'Cash and bank',
  valuePaise: '4900000',
  caption: 'What the books say you hold. Not yet reconciled to a statement.',
  status: 'provisional',
  statusReason: 'No bank statement has been reconciled against this.',
  trace: [],
};

const provisional: Metric = {
  key: 'revenue',
  label: 'Revenue',
  valuePaise: '16000000',
  caption: 'Taxable value of sales.',
  status: 'provisional',
  statusReason: 'The period is still open, so this can change.',
  trace: [],
};

afterEach(cleanup);

describe('MetricCards', () => {
  it('shows each figure with its status badge', () => {
    render(<MetricCards metrics={[withTrace, withoutTrace, provisional]} />);
    expect(screen.getByText('Customers owe')).toBeDefined();
    expect(screen.getByText('Cash and bank')).toBeDefined();
    expect(screen.getByText('verified')).toBeDefined();
    expect(screen.getAllByText('provisional')).toHaveLength(2);
  });

  it('formats a figure in Indian compact notation', () => {
    render(<MetricCards metrics={[withTrace]} />);
    // ₹1,29,800 reads as ₹1.3L, not ₹130K.
    expect(screen.getByText('₹1.3L')).toBeDefined();
  });

  it('tells a screen reader what opening a card will show', () => {
    render(<MetricCards metrics={[withTrace]} />);
    const card = screen.getByRole('button', { name: /Customers owe/ });
    expect(card.getAttribute('aria-label')).toMatch(/₹1,29,800\.00/);
    expect(card.getAttribute('aria-label')).toMatch(/3 vouchers behind it/);
  });

  describe('the trace drawer', () => {
    it('opens with the vouchers the figure is made of', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));

      expect(screen.getByText('3 vouchers make up this figure.')).toBeDefined();
      expect(screen.getByText('INV/25-26/0001')).toBeDefined();
      expect(screen.getByText('INV/25-26/0003')).toBeDefined();
    });

    it('shows the exact figure, not the compact one', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      // The card rounds for scanning; the drawer must not.
      expect(screen.getByText('₹1,29,800.00')).toBeDefined();
    });

    it('lists amounts that add up to the figure on the card', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      const total = withTrace.trace.reduce((a, t) => a + BigInt(t.amountPaise), 0n);
      expect(total).toBe(BigInt(withTrace.valuePaise));
    });

    it('says why the status is what it is', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      expect(screen.getByText(/Agrees with the Sundry Debtors control account/)).toBeDefined();
    });

    it('links a sales voucher to its PDF, so the trail reaches a document', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      const link = screen.getByText('INV/25-26/0001') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/api/invoices/v1/pdf');
    });

    it('notes which vouchers have a source document attached', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      expect(screen.getAllByText('Source document attached')).toHaveLength(1);
    });

    it('says plainly when a figure is a balance rather than a list', () => {
      render(<MetricCards metrics={[withoutTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Cash and bank/ }));
      // An empty table would imply the figure came from nothing.
      expect(screen.getByText(/a balance drawn from the ledger rather than a list/)).toBeDefined();
      expect(screen.queryByText(/vouchers make up this figure/)).toBeNull();
    });

    it('carries the professional-review line into the drawer', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      expect(screen.getByText(/review by a qualified professional/)).toBeDefined();
    });

    it('closes on the Close button', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByText('3 vouchers make up this figure.')).toBeNull();
    });

    it('closes on Escape, so the panel cannot trap the reader', () => {
      render(<MetricCards metrics={[withTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByText('3 vouchers make up this figure.')).toBeNull();
    });

    it('opens only one drawer at a time', () => {
      render(<MetricCards metrics={[withTrace, withoutTrace]} />);
      fireEvent.click(screen.getByRole('button', { name: /Customers owe/ }));
      fireEvent.click(screen.getByRole('button', { name: /Cash and bank/ }));
      expect(screen.queryByText('3 vouchers make up this figure.')).toBeNull();
      expect(screen.getByText(/a balance drawn from the ledger/)).toBeDefined();
    });
  });

  it('renders nothing but an empty grid when there are no metrics', () => {
    render(<MetricCards metrics={[]} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
