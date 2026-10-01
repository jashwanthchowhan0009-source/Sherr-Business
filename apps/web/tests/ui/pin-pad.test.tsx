import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PinPad } from '../../src/app/(onboarding)/lock/PinPad';
import { createPin, resetPin, unlockScreen } from '../../src/server/screen-lock';

vi.mock('../../src/server/screen-lock', () => ({
  createPin: vi.fn(async () => ({ ok: true, data: { created: true } })),
  unlockScreen: vi.fn(async () => ({ ok: true, data: { unlocked: true } })),
  resetPin: vi.fn(async () => ({ ok: true, data: { reset: true } })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/components/brand/Logo', () => ({
  LogoMark: () => <span data-testid="mark" />,
}));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

/** Types a six-digit code into one of the labelled groups of boxes. */
function type(label: string, digits: string) {
  for (let i = 0; i < digits.length; i += 1) {
    fireEvent.change(screen.getByLabelText(`${label}, digit ${i + 1}`), {
      target: { value: digits[i] },
    });
  }
}

describe('PinPad — setting the first PIN', () => {
  it('asks twice and sends both', async () => {
    render(<PinPad mode="set" />);
    type('PIN', '481937');
    type('Confirm PIN', '481937');
    fireEvent.click(screen.getByRole('button', { name: 'Set PIN' }));
    await waitFor(() =>
      expect(vi.mocked(createPin)).toHaveBeenCalledWith({ pin: '481937', confirm: '481937' }),
    );
  });

  it('will not submit on one entry alone', () => {
    // A mistyped first PIN that nobody can enter afterwards is the one failure
    // this screen must not allow, because the way back is through the
    // authenticator.
    render(<PinPad mode="set" />);
    type('PIN', '481937');
    expect((screen.getByRole('button', { name: 'Set PIN' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the PIN itself is not kept', () => {
    render(<PinPad mode="set" />);
    expect(screen.getByText(/only a hash of it is/)).toBeDefined();
  });

  it('describes when it will be asked for — a new tab and five idle minutes', () => {
    render(<PinPad mode="set" />);
    expect(screen.getByText(/five minutes of inactivity/)).toBeDefined();
  });
});

describe('PinPad — entering it', () => {
  it('submits on the sixth digit without a click', async () => {
    render(<PinPad mode="enter" />);
    type('PIN', '481937');
    await waitFor(() => expect(vi.mocked(unlockScreen)).toHaveBeenCalledWith({ pin: '481937' }));
  });

  it('shows the error and clears the boxes so the next try starts clean', async () => {
    vi.mocked(unlockScreen).mockResolvedValueOnce({
      ok: false,
      error: 'Wrong PIN. 4 attempts left before it locks.',
    } as Awaited<ReturnType<typeof unlockScreen>>);
    render(<PinPad mode="enter" />);
    type('PIN', '111111');
    await waitFor(() => expect(screen.getByText(/4 attempts left/)).toBeDefined());
    expect((screen.getByLabelText('PIN, digit 1') as HTMLInputElement).value).toBe('');
  });

  it('offers a way out for somebody who has forgotten it', () => {
    const link = screen.queryByRole.bind(screen);
    render(<PinPad mode="enter" />);
    expect(link('link', { name: /Forgotten your PIN/ })?.getAttribute('href')).toBe('/lock?reset=1');
  });

  it('keeps the digits off the screen', () => {
    render(<PinPad mode="enter" />);
    expect((screen.getByLabelText('PIN, digit 1') as HTMLInputElement).type).toBe('password');
  });
});

describe('PinPad — the reset, which only the authenticator opens', () => {
  it('collects no digits while the second factor is stale', () => {
    render(<PinPad mode="reset" lockedOut />);
    expect(screen.queryByLabelText('PIN, digit 1')).toBeNull();
    expect(screen.getByRole('button', { name: /Sign out and verify/ })).toBeDefined();
  });

  it('says plainly that five wrong attempts closed it, and that nothing is lost', () => {
    render(<PinPad mode="reset" lockedOut />);
    expect(screen.getByText(/Five wrong attempts closed it/)).toBeDefined();
    expect(screen.getByText(/your books are untouched/)).toBeDefined();
  });

  it('takes a new PIN once the second factor is fresh', async () => {
    render(<PinPad mode="reset" lockedOut reverified />);
    type('PIN', '728164');
    type('Confirm PIN', '728164');
    fireEvent.click(screen.getByRole('button', { name: 'Set new PIN' }));
    await waitFor(() =>
      expect(vi.mocked(resetPin)).toHaveBeenCalledWith({ pin: '728164', confirm: '728164' }),
    );
  });

  it('never calls unlock from the reset screen', async () => {
    render(<PinPad mode="reset" reverified />);
    type('PIN', '728164');
    type('Confirm PIN', '728164');
    fireEvent.click(screen.getByRole('button', { name: 'Set new PIN' }));
    await waitFor(() => expect(vi.mocked(resetPin)).toHaveBeenCalled());
    expect(vi.mocked(unlockScreen)).not.toHaveBeenCalled();
  });

  it('does not auto-submit on the sixth digit, because a reset is deliberate', () => {
    render(<PinPad mode="reset" reverified />);
    type('PIN', '728164');
    expect(vi.mocked(resetPin)).not.toHaveBeenCalled();
  });
});
