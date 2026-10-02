import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { LockOnHide } from '../../src/components/shell/LockOnHide';
import { lockScreen } from '../../src/server/screen-lock';
import { markTabUnlocked } from '../../src/lib/auth/tab-session';

const replace = vi.fn();

vi.mock('../../src/server/screen-lock', () => ({
  lockScreen: vi.fn(async () => ({ ok: true, data: { locked: true } })),
}));
let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  usePathname: () => pathname,
}));

const IDLE_MS = 5 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  pathname = '/dashboard';
  sessionStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Lets the queued microtasks behind `void lockNow()` settle. */
const settle = () => act(async () => { await Promise.resolve(); });

describe('when the lock is asked for', () => {
  it('asks on a tab that has never unlocked', async () => {
    render(<LockOnHide />);
    await settle();
    expect(vi.mocked(lockScreen)).toHaveBeenCalled();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/lock'));
  });

  it('does not ask again on a tab that has', async () => {
    markTabUnlocked();
    render(<LockOnHide />);
    await settle();
    expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();
  });

  it('asks after five idle minutes', async () => {
    markTabUnlocked();
    render(<LockOnHide />);
    await settle();

    await act(async () => { vi.advanceTimersByTime(IDLE_MS - 1000); });
    expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(vi.mocked(lockScreen)).toHaveBeenCalledTimes(1);
  });

  it('does not ask while somebody is working', async () => {
    markTabUnlocked();
    render(<LockOnHide />);
    await settle();

    // Four minutes, a keystroke, four more. An accountant mid-entry is not idle.
    await act(async () => { vi.advanceTimersByTime(4 * 60 * 1000); });
    fireEvent.keyDown(window, { key: 'a' });
    await act(async () => { vi.advanceTimersByTime(4 * 60 * 1000); });
    expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();
  });

  it.each(['pointerdown', 'keydown', 'scroll', 'focus'] as const)(
    'counts %s as somebody being there',
    async (event) => {
      markTabUnlocked();
      render(<LockOnHide />);
      await settle();

      await act(async () => { vi.advanceTimersByTime(IDLE_MS - 1000); });
      window.dispatchEvent(new Event(event));
      await act(async () => { vi.advanceTimersByTime(IDLE_MS - 1000); });
      expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();
    },
  );

  it('never asks on the lock screen itself', async () => {
    // It would clear the unlock the user is in the middle of establishing.
    pathname = '/lock';
    render(<LockOnHide />);
    await settle();
    await act(async () => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();
  });
});

describe('when the lock is not asked for', () => {
  it('ignores a tab switch away and back', async () => {
    // The whole point of the refinement: an accountant works with the books
    // beside a bank statement and three supplier emails. A lock on every
    // alt-tab gets switched off, and then protects nothing.
    markTabUnlocked();
    render(<LockOnHide />);
    await settle();

    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('pagehide'));
    fireEvent(window, new Event('blur'));
    await act(async () => { vi.advanceTimersByTime(60 * 1000); });

    expect(vi.mocked(lockScreen)).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('forgets the tab marker when it does lock, so the tab is asked again', async () => {
    markTabUnlocked();
    render(<LockOnHide />);
    await settle();
    await act(async () => { vi.advanceTimersByTime(IDLE_MS + 1000); });
    await waitFor(() => expect(sessionStorage.getItem('sb.unlocked-tab')).toBeNull());
  });
});
