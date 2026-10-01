import { Dock } from '@/components/shell/Dock';
import { TopBar } from '@/components/shell/TopBar';
import { LockOnHide } from '@/components/shell/LockOnHide';
import shell from '@/components/shell/shell.module.css';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Ends the unlock as soon as the tab is switched away from. */}
      <LockOnHide />
      <TopBar />
      <main className={shell.stage}>{children}</main>
      <Dock />
    </>
  );
}
