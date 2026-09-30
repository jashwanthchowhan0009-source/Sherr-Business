import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { clerkConfigured } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: 'SherrByte Business',
  description:
    'Verified accounting, taxation and reporting for Indian companies, their accountants and their CAs.',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const body = (
    <html lang="en">
      <body>{children}</body>
    </html>
  );

  // Without Clerk keys the provider throws at render. The app still boots so the
  // database layer and the shell can be worked on; protected routes stay closed.
  if (!clerkConfigured()) return body;

  // Where Clerk sends someone already signed in who lands on /sign-in or
  // /sign-up. Left unset these default to "/", so the console reported
  // "<SignIn/> cannot render when a user is already signed in ... redirecting to
  // the afterSignIn URL" and the visitor was bounced back to the marketing page
  // that had just invited them to sign in. /dashboard sits behind the MFA gate,
  // so an un-enrolled user still stops at /onboarding/mfa rather than slipping in.
  return (
    <ClerkProvider signInFallbackRedirectUrl="/dashboard" signUpFallbackRedirectUrl="/dashboard">
      {body}
    </ClerkProvider>
  );
}
