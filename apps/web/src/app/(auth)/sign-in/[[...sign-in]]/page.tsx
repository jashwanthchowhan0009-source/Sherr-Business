import { SignIn } from '@clerk/nextjs';
import { LogoLockup } from '@/components/brand/Logo';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '48px 16px' }}>
      <div>
        {/* Somebody arriving here from a link has nothing else telling them
            whose sign-in box this is, which is the one page where that
            matters most. */}
        <LogoLockup subtitle="Sign in to your books" />
        <SignIn />
      </div>
    </main>
  );
}
