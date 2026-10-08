import { AppShell } from '@/components/shell/AppShell';
import { LockOnHide } from '@/components/shell/LockOnHide';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Locks after five idle minutes, and on a tab that has not unlocked. */}
      <LockOnHide />
      <AppShell>{children}</AppShell>
    </>
  );
}
