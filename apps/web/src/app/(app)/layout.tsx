import { Dock } from '@/components/shell/Dock';
import { TopBar } from '@/components/shell/TopBar';
import { LockOnHide } from '@/components/shell/LockOnHide';
import shell from '@/components/shell/shell.module.css';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Locks after five idle minutes, and on a tab that has not unlocked. */}
      <LockOnHide />
      <TopBar />
      <main className={shell.stage}>{children}</main>
      <Dock />
    </>
  );
}
