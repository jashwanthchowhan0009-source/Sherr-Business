import { redirect } from 'next/navigation';
import { Panel } from '@/components/ui';
import { optionalOrgContext } from '@/lib/auth/context';
import { TopBar } from '@/components/shell/TopBar';
import shell from '@/components/shell/shell.module.css';
import { CompanyForm } from './CompanyForm';

export const dynamic = 'force-dynamic';

/**
 * Where a signed-in user with no company lands.
 *
 * No dock: there is nothing to navigate to until a company exists, and showing
 * a disabled one would only invite clicks that go nowhere.
 */
export default async function CreateCompanyPage() {
  // Already in a company — nothing to create.
  if (await optionalOrgContext()) redirect('/dashboard');

  return (
    <>
      <TopBar />
      <main className={shell.stage} style={{ paddingBottom: 96, maxWidth: 780 }}>
        <h1 className={shell.title} style={{ marginBottom: 8 }}>Create your company</h1>
        <p className={shell.sub}>
          This sets up your books. You can change any of it later, except the date your
          books start from once entries exist.
        </p>
        <Panel>
          <CompanyForm />
        </Panel>
      </main>
    </>
  );
}
