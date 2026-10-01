import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewForm } from '../../src/app/(app)/input/review/[id]/ReviewForm';
import { DocumentPane } from '../../src/app/(app)/input/review/[id]/DocumentPane';
import { parseExtractedDocument } from '../../src/lib/ai/parse';
import { CONFIDENCE_FLOOR } from '../../src/lib/ai/contract';
import { approveExtraction, rejectExtraction, saveExtractionReview } from '../../src/server/inbox';

vi.mock('../../src/server/inbox', () => ({
  approveExtraction: vi.fn(async () => ({
    ok: true,
    data: { voucherNo: 'BILL/25-26/0007', voucherId: 'v1', posted: false },
  })),
  saveExtractionReview: vi.fn(async () => ({ ok: true, data: { extractionId: 'e1' } })),
  rejectExtraction: vi.fn(async () => ({ ok: true, data: { extractionId: 'e1' } })),
  extractDocument: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const PARTIES = [
  { id: 'p1', name: 'Sunrise Traders', gstin: '29AABCS1234A1ZX', stateCode: '29' },
  { id: 'p2', name: 'Anand Enterprises', gstin: null, stateCode: '27' },
];

const extracted = (over: Record<string, unknown> = {}) =>
  parseExtractedDocument({
    kind: 'purchase_invoice',
    supplierName: { value: 'Sunrise Traders', confidence: 0.96 },
    supplierGstin: { value: '29AABCS1234A1ZX', confidence: 0.94 },
    invoiceNumber: { value: 'ST/2025-26/0101', confidence: 0.95 },
    invoiceDate: { value: '12/06/2025', confidence: 0.93 },
    placeOfSupplyStateCode: { value: '29', confidence: 0.9 },
    lines: [
      {
        description: { value: 'Steel fittings', confidence: 0.95 },
        hsnSac: { value: '7307', confidence: 0.9 },
        quantity: { value: '20', confidence: 0.9 },
        unit: { value: 'NOS', confidence: 0.9 },
        rate: { value: '5000', confidence: 0.9 },
        taxableAmount: { value: '1,00,000.00', confidence: 0.95 },
        gstRatePercent: { value: '18', confidence: 0.95 },
      },
    ],
    statedGrandTotal: { value: '118000', confidence: 0.96 },
    ...over,
  });

const setup = (over: Partial<Parameters<typeof ReviewForm>[0]> = {}) =>
  render(
    <ReviewForm
      extractionId="e1"
      extracted={extracted()}
      reviewed={null}
      parties={PARTIES}
      suggestedParty={{ id: 'p1', name: 'Sunrise Traders', matchedOn: 'gstin' }}
      companyStateCode="29"
      lockedUpto={null}
      confidenceFloor={CONFIDENCE_FLOOR}
      readOnly={false}
      {...over}
    />,
  );

describe('ReviewForm', () => {
  it('says plainly that approving creates a draft and cannot post', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Approve as a draft voucher' })).toBeDefined();
    expect(screen.getByText(/Nothing here can post a voucher/)).toBeDefined();
    // Nothing on the form offers to post.
    expect(screen.queryByRole('button', { name: /^Post/ })).toBeNull();
  });

  it('starts from what the model read, with the reading still shown beside it', () => {
    // A form that silently adopted the model's values would make "approved" mean
    // nothing, so the reading stays visible next to the field it filled.
    setup();
    expect((screen.getByLabelText("Supplier's invoice number") as HTMLInputElement).value).toBe(
      'ST/2025-26/0101',
    );
    expect(screen.getByText(/Read as: “ST\/2025-26\/0101”/)).toBeDefined();
    expect(screen.getByText(/Printed as: “12\/06\/2025”/)).toBeDefined();
  });

  it('converts the printed day-first date into the ISO value the input needs', () => {
    // 12/06/2025 is 12 June, not 6 December.
    setup();
    expect((screen.getByLabelText('Invoice date') as HTMLInputElement).value).toBe('2025-06-12');
  });

  it('strips the rupee formatting off an amount it reads into a field', () => {
    setup();
    expect((screen.getByLabelText('Rate on line 1') as HTMLInputElement).value).toBe('100000.00');
  });

  it('selects the supplier matched on GSTIN and says why', () => {
    setup();
    expect((screen.getByLabelText('Supplier') as HTMLSelectElement).value).toBe('p1');
    expect(screen.getByText(/identifies a business exactly/)).toBeDefined();
  });

  it('marks a field the model was unsure of, with the number', () => {
    setup({
      extracted: extracted({ invoiceNumber: { value: 'ST/0101', confidence: 0.42 } }),
    });
    expect(screen.getByText(/only 42% confident, check this/)).toBeDefined();
  });

  it('says when a field was not on the document at all', () => {
    setup({ extracted: extracted({ invoiceNumber: { value: null, confidence: 0 } }) });
    expect(screen.getByText(/Read as: nothing found on the document/)).toBeDefined();
  });

  it('warns that no supplier matched, rather than leaving the field blank in silence', () => {
    setup({ suggestedParty: null });
    expect((screen.getByLabelText('Supplier') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/puts the bill on the wrong account/)).toBeDefined();
  });

  it('sends the edited values, not the model’s', async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Supplier's invoice number"), {
      target: { value: 'CORRECTED/9' },
    });
    fireEvent.change(screen.getByLabelText('Rate on line 1'), { target: { value: '99000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve as a draft voucher' }));

    await waitFor(() => expect(approveExtraction).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(approveExtraction).mock.calls[0]![0] as {
      supplierInvoiceNo: string;
      lines: { unitPriceRupees: string; gstRateBps: number }[];
    };
    expect(sent.supplierInvoiceNo).toBe('CORRECTED/9');
    expect(sent.lines[0]!.unitPriceRupees).toBe('99000');
    expect(sent.lines[0]!.gstRateBps).toBe(1800);
  });

  it('reports the draft it created, and that it is not in the books', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Approve as a draft voucher' }));
    expect(await screen.findByText(/Created draft BILL\/25-26\/0007/)).toBeDefined();
    expect(screen.getByText(/not in the books/)).toBeDefined();
  });

  it('saves a part-finished review without creating anything', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save without creating' }));
    await waitFor(() => expect(saveExtractionReview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nothing has been created yet/)).toBeDefined();
    expect(approveExtraction).not.toHaveBeenCalled();
  });

  it('resumes from a saved review rather than from the model', () => {
    setup({
      reviewed: {
        partyId: 'p2',
        voucherDate: '2025-06-20',
        supplierInvoiceNo: 'EDITED/1',
        placeOfSupplyStateCode: '27',
        narration: 'checked against the PO',
        lines: [
          {
            description: 'Edited line',
            hsnSac: '7308',
            unit: 'KG',
            quantity: '2',
            unitPriceRupees: '500',
            discountRupees: '0',
            gstRateBps: 500,
            reverseCharge: false,
          },
        ],
      },
    });

    expect((screen.getByLabelText('Supplier') as HTMLSelectElement).value).toBe('p2');
    expect((screen.getByLabelText("Supplier's invoice number") as HTMLInputElement).value).toBe(
      'EDITED/1',
    );
    expect((screen.getByLabelText('Description on line 1') as HTMLInputElement).value).toBe(
      'Edited line',
    );
  });

  it('shows the server’s refusal rather than claiming a draft was made', async () => {
    vi.mocked(approveExtraction).mockResolvedValueOnce({
      ok: false,
      error: 'Sunrise Traders invoice ST/2025-26/0101 is already entered as BILL/25-26/0003.',
    } as never);

    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Approve as a draft voucher' }));
    expect(await screen.findByText(/already entered as BILL\/25-26\/0003/)).toBeDefined();
    expect(screen.queryByText(/Created draft/)).toBeNull();
  });

  it('requires a reason before it will reject a reading', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Reject this reading' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Why is this being rejected?'), {
      target: { value: 'This is a delivery note, not a bill' },
    });
    expect((screen.getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() =>
      expect(rejectExtraction).toHaveBeenCalledWith({
        extractionId: 'e1',
        reason: 'This is a delivery note, not a bill',
      }),
    );
  });

  it('says the books are closed when they are', () => {
    setup({ lockedUpto: '2025-06-30' });
    expect(screen.getByText(/books are closed to 2025-06-30/)).toBeDefined();
  });

  it('notes that an inter-state supply means IGST', () => {
    setup({ suggestedParty: { id: 'p2', name: 'Anand Enterprises', matchedOn: 'name' } });
    // p2 is in 27, place of supply defaults to 29.
    expect(screen.getByText(/inter-state supply and IGST applies/)).toBeDefined();
  });

  it('offers nothing to a role that cannot draft a voucher', () => {
    setup({ readOnly: true });
    expect(screen.queryByRole('button', { name: 'Approve as a draft voucher' })).toBeNull();
    expect(screen.getByText(/cannot create a voucher from it/)).toBeDefined();
  });

  it('lets a line be added and removed', () => {
    setup();
    expect(screen.queryByLabelText('Description on line 2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }));
    expect(screen.getByLabelText('Description on line 2')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.queryByLabelText('Description on line 2')).toBeNull();
  });

  it('starts a blank form when the model read no lines at all', () => {
    setup({ extracted: extracted({ lines: [] }) });
    expect(screen.getByLabelText('Description on line 1')).toBeDefined();
    expect((screen.getByLabelText('Description on line 1') as HTMLInputElement).value).toBe('');
  });
});

describe('DocumentPane', () => {
  it('frames a PDF', () => {
    render(<DocumentPane documentId="d1" mimeType="application/pdf" filename="bill.pdf" />);
    const frame = screen.getByTitle('bill.pdf');
    expect(frame.getAttribute('src')).toBe('/api/documents/d1');
  });

  it('shows an image', () => {
    render(<DocumentPane documentId="d1" mimeType="image/png" filename="bill.png" />);
    expect(screen.getByAltText('bill.png').getAttribute('src')).toBe('/api/documents/d1');
  });

  it('offers a download for anything the browser cannot render', () => {
    // Better than an empty frame that looks broken.
    render(<DocumentPane documentId="d1" mimeType="text/csv" filename="bill.csv" />);
    expect(screen.getByText(/cannot be shown in the browser/)).toBeDefined();
    expect(screen.getByText('Download bill.csv')).toBeDefined();
  });
});
