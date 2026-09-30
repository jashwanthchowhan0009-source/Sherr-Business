import { Dock } from '@/components/shell/Dock';
import { TopBar } from '@/components/shell/TopBar';
import shell from '@/components/shell/shell.module.css';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      <main className={shell.stage}>{children}</main>
      <Dock />
    </>
  );
}
