import type { Metadata, Viewport } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { clerkConfigured } from '@/lib/env';
import './globals.css';

const DESCRIPTION =
  'Verified accounting, taxation and reporting for Indian companies, their accountants and ' +
  'their CAs.';

export const metadata: Metadata = {
  // Needed for the link-preview image to resolve to an absolute URL. Without it
  // Next warns and shared links preview with no picture at all. Vercel sets
  // VERCEL_URL per deployment; the localhost fallback keeps development quiet.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
  ),
  title: {
    default: 'SherrByte Business',
    // Applies to any page that exports a title of its own. None do yet — the
    // headings on screen come from PageHeader, which renders an h1 and sets no
    // metadata — so this is the shape a page title takes when one is added.
    template: '%s · SherrByte',
  },
  description: DESCRIPTION,
  applicationName: 'SherrByte Business',
  // The icons themselves are picked up from app/icon.png and app/apple-icon.png
  // by Next's file conventions, and the preview image from
  // app/opengraph-image.png — none of the three is listed here.
  openGraph: {
    type: 'website',
    siteName: 'SherrByte Business',
    title: 'SherrByte Business',
    description: DESCRIPTION,
    locale: 'en_IN',
  },
  twitter: { card: 'summary_large_image', title: 'SherrByte Business', description: DESCRIPTION },
  // A company's books are not something to surface in a search index.
  robots: { index: false, follow: false },
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
