import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanyForm } from '../../src/app/(onboarding)/onboarding/company/CompanyForm';
import { createCompany } from '../../src/server/onboarding';

vi.mock('../../src/server/onboarding', () => ({
  createCompany: vi.fn(async () => ({ ok: true, data: { orgId: 'o1', clerkOrgId: 'org_1' } })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@clerk/nextjs', () => ({ useOrganizationList: () => ({ setActive: vi.fn() }) }));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const sent = () => vi.mocked(createCompany).mock.calls[0]![0] as Record<string, unknown>;

const fill = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('CompanyForm', () => {
  it('does not demand a GSTIN from a registered business', () => {
    // GST registration is compulsory only above the turnover thresholds, and
    // somebody who is registered may not have the number to hand. Refusing to
    // open the books over a field that can be filled in later helps nobody.
    render(<CompanyForm />);
    expect(screen.getByLabelText(/GSTIN/)).toBeDefined();
    expect(screen.getByText(/You can add it later instead/)).toBeDefined();
  });

  it('asks for a PIN code and works the state out from it', () => {
    render(<CompanyForm />);
    fill('PIN code', '110001');
    const state = screen.getByLabelText('State') as HTMLSelectElement;
    expect(state.value).toBe('07');
    expect(screen.getByText(/From your PIN code/)).toBeDefined();
  });

  it('offers both states where a PIN code spans two, and preselects neither', () => {
    // Telangana and Andhra Pradesh share a range. Picking one silently would
    // turn an intra-state supply into an inter-state one.
    render(<CompanyForm />);
    fill('PIN code', '500001');

    const state = screen.getByLabelText('State') as HTMLSelectElement;
    expect(state.value).toBe('');
    expect(screen.getByText(/covers more than one state/)).toBeDefined();

    const names = [...state.options].map((o) => o.textContent);
    expect(names).toContain('Telangana');
    expect(names).toContain('Andhra Pradesh');
    expect(names).not.toContain('Kerala');
  });

  it('falls back to every state when the PIN code says nothing', () => {
    render(<CompanyForm />);
    fill('PIN code', '900001');
    const state = screen.getByLabelText('State') as HTMLSelectElement;
    expect(state.options.length).toBeGreaterThan(30);
  });

  it('lets the suggestion be overridden', () => {
    render(<CompanyForm />);
    fill('PIN code', '248001');          // Uttar Pradesh or Uttarakhand
    fill('State', '05');                  // Uttarakhand
    expect((screen.getByLabelText('State') as HTMLSelectElement).value).toBe('05');
  });

  it('drops an earlier choice when the PIN code changes', () => {
    // Otherwise a corrected PIN code leaves the old state silently attached.
    render(<CompanyForm />);
    fill('PIN code', '248001');
    fill('State', '05');
    fill('PIN code', '110001');
    expect((screen.getByLabelText('State') as HTMLSelectElement).value).toBe('07');
  });

  it('takes the state from the GSTIN and stops asking twice', () => {
    render(<CompanyForm />);
    fill(/GSTIN/, '36AABCU9603R1ZO');     // Telangana, checksum-valid
    const state = screen.getByLabelText('State') as HTMLSelectElement;
    expect(state.value).toBe('36');
    expect(state.disabled).toBe(true);
    expect((screen.getByLabelText('PIN code') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(/Read from your GSTIN/).length).toBeGreaterThan(0);
  });

  it('hides the GSTIN field for an unregistered business', () => {
    render(<CompanyForm />);
    fireEvent.change(screen.getByLabelText('GST registration'), { target: { value: 'unregistered' } });
    expect(screen.queryByLabelText(/GSTIN/)).toBeNull();
    // The state is still asked for: it decides CGST/SGST against IGST.
    expect(screen.getByLabelText('State')).toBeDefined();
  });

  it('submits the state it is showing, GSTIN or not', async () => {
    render(<CompanyForm />);
    fill('Registered legal name', 'Acme Private Limited');
    fill('PIN code', '110001');
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));

    await waitFor(() => expect(createCompany).toHaveBeenCalledTimes(1));
    expect(sent().stateCode).toBe('07');
    expect(sent().gstin).toBe('');
    expect(sent().legalName).toBe('Acme Private Limited');
  });

  it('keeps only digits in the PIN code, and at most six', () => {
    render(<CompanyForm />);
    fill('PIN code', '5a0b0-0 01999');
    expect((screen.getByLabelText('PIN code') as HTMLInputElement).value).toBe('500001');
  });
});
