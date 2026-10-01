import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LogoGlyph, LogoLockup, LogoMark } from '../../src/components/brand/Logo';
import { TopBar } from '../../src/components/shell/TopBar';

// next/image does real work in a browser and none of it matters here; what
// matters is which file is asked for and how it is labelled.
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, width, height, priority, ...rest } = props;
    return (
      <img
        src={String(src)}
        alt={String(alt ?? '')}
        width={Number(width)}
        height={Number(height)}
        data-priority={priority ? 'true' : 'false'}
        {...rest}
      />
    );
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: Record<string, unknown> & { children: React.ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@clerk/nextjs', () => ({ UserButton: () => <div data-testid="user-button" /> }));

afterEach(cleanup);

describe('LogoGlyph', () => {
  it('uses the eye crop, not the full mark', () => {
    // The full mark is 469x732 of claw; at these sizes it is a grey smudge and
    // the eye — the only recognisable part — is a few pixels of nothing.
    const { container } = render(<LogoGlyph size={42} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/brand/glyph.png');
    expect(img.getAttribute('width')).toBe('42');
    expect(img.getAttribute('height')).toBe('42');
  });

  it('is decorative, so a screen reader does not read the name twice', () => {
    // The product's name is written beside the mark everywhere it appears.
    const { container } = render(<LogoGlyph />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('LogoMark', () => {
  it('keeps the artwork’s own proportions rather than letting them drift', () => {
    const { container } = render(<LogoMark height={732} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/brand/mark.png');
    expect(img.getAttribute('height')).toBe('732');
    // 469 x 732 is the trimmed source.
    expect(img.getAttribute('width')).toBe('469');
  });

  it('scales width with height', () => {
    const { container } = render(<LogoMark height={366} />);
    expect(container.querySelector('img')!.getAttribute('width')).toBe('235');
  });

  it('loads eagerly only when told to', () => {
    const { container, rerender } = render(<LogoMark height={100} />);
    expect(container.querySelector('img')!.getAttribute('data-priority')).toBe('false');
    rerender(<LogoMark height={100} priority />);
    expect(container.querySelector('img')!.getAttribute('data-priority')).toBe('true');
  });
});

describe('LogoLockup', () => {
  it('names the product, because a bare auth box does not', () => {
    render(<LogoLockup subtitle="Sign in to your books" />);
    expect(screen.getByText('SherrByte')).toBeDefined();
    expect(screen.getByText('Sign in to your books')).toBeDefined();
  });

  it('omits the subtitle when there is none', () => {
    const { container } = render(<LogoLockup />);
    expect(container.textContent).toBe('SherrByte');
  });
});

describe('TopBar', () => {
  it('shows the mark and makes it the way home', () => {
    // It was a bare letter in a circle before: it looked like a brand mark and
    // did nothing when clicked.
    render(<TopBar />);
    const home = screen.getByRole('link', { name: /SherrByte/ });
    expect(home.getAttribute('href')).toBe('/dashboard');
    expect(home.querySelector('img')!.getAttribute('src')).toBe('/brand/glyph.png');
  });

  it('labels that link, since the mark itself carries no text', () => {
    render(<TopBar />);
    expect(screen.getByLabelText('SherrByte — go to the dashboard')).toBeDefined();
  });

  it('still offers the account button', () => {
    render(<TopBar />);
    expect(screen.getByTestId('user-button')).toBeDefined();
  });
});
