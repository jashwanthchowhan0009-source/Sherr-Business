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
  return clerkConfigured() ? <ClerkProvider>{body}</ClerkProvider> : body;
}
