import { redirect } from 'next/navigation';
import { Panel } from '@/components/ui';
import { optionalOrgContext } from '@/lib/auth/context';
import { LogoGlyph } from '@/components/brand/Logo';
import shell from '@/components/shell/shell.module.css';
import { CompanyForm } from './CompanyForm';

export const dynamic = 'force-dynamic';

/**
 * Where a signed-in user with no company lands.
 *
 * No navigation: there is nothing to navigate to until a company exists, and
 * showing a disabled rail would only invite clicks that go nowhere.
 */
export default async function CreateCompanyPage() {
  // Already in a company — nothing to create.
  if (await optionalOrgContext()) redirect('/dashboard');

  return (
    <>
      <div className={shell.brandBar}>
        <span className={shell.brand}>
          <LogoGlyph size={30} priority />
          <span className={shell.brandText}>
            <span className={shell.brandName}>SherrByte</span>
            <span className={shell.brandSub}>Businesses</span>
          </span>
        </span>
      </div>
      <main className={shell.stageSolo}>
        <h1 className={shell.title}>Create your company</h1>
        <p className={shell.sub}>
          You can change any of this later, except the books start date once entries exist.
        </p>
        <Panel>
          <CompanyForm />
        </Panel>
      </main>
    </>
  );
}
