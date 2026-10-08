import { SignUp } from '@clerk/nextjs';
import { LogoLockup } from '@/components/brand/Logo';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return (
    <main data-theme="dark" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '48px 16px' }}>
      <div>
        <LogoLockup subtitle="Create an account" />
        <SignUp />
      </div>
    </main>
  );
}
