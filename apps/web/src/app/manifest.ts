import type { MetadataRoute } from 'next';

/**
 * The web manifest, so the app installs to a phone's home screen with its own
 * mark rather than a screenshot of the page.
 *
 * `standalone` because the product is a full screen of its own: an address bar
 * over a bookkeeping dock wastes a row of a small screen and invites someone to
 * navigate away mid-entry. The colours match the app's canvas so the splash does
 * not flash white before the first paint.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SherrByte Business',
    short_name: 'SherrByte',
    description:
      'Verified accounting, taxation and reporting for Indian companies, their accountants ' +
      'and their CAs.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#f3f5f8',
    theme_color: '#0e1729',
    icons: [
      { src: '/brand/glyph.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
