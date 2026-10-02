import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteDocumentButton } from '../../src/app/(app)/input/DeleteDocumentButton';
import { deleteDocument } from '../../src/server/documents';

const refresh = vi.fn();
vi.mock('../../src/server/documents', () => ({
  deleteDocument: vi.fn(async () => ({ ok: true, data: { id: 'd1' } })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const open = () => render(<DeleteDocumentButton id="d1" filename="bill.pdf" />);

describe('deleting a document', () => {
  it('asks once before doing it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Delete bill.pdf/ }));
    expect(screen.getByRole('button', { name: 'Sure?' })).toBeDefined();
    expect(vi.mocked(deleteDocument)).not.toHaveBeenCalled();
  });

  it('deletes only on the second click', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Delete bill.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sure?' }));
    await waitFor(() => expect(vi.mocked(deleteDocument)).toHaveBeenCalledWith({ id: 'd1' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('backs out without deleting', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Delete bill.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: /Delete bill.pdf/ })).toBeDefined();
    expect(vi.mocked(deleteDocument)).not.toHaveBeenCalled();
  });

  it('shows the server refusal rather than pretending it worked', async () => {
    // A document behind a posted voucher is evidence for a number in the books,
    // and the server refuses to remove it. The row must say so.
    vi.mocked(deleteDocument).mockResolvedValueOnce({
      ok: false,
      error: 'This document is the source of a posted voucher and cannot be deleted.',
    } as Awaited<ReturnType<typeof deleteDocument>>);
    open();
    fireEvent.click(screen.getByRole('button', { name: /Delete bill.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sure?' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/cannot be deleted/));
    expect(refresh).not.toHaveBeenCalled();
  });
});
