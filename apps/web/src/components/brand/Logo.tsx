import Image from 'next/image';
import styles from './brand.module.css';

/**
 * The mark, in the three sizes the product actually uses.
 *
 * Two files rather than one, because the artwork does not survive being scaled
 * down. The full mark is 469×732 of claw; at 42px that is a grey smudge and the
 * eye — the only part anybody recognises — is six pixels of nothing. So the small
 * sizes use a square crop centred on the eye, and the large ones use the whole
 * tear. Both are cut from the same source file by `brand/README.md`'s recipe.
 *
 * Everything here assumes a dark surface. The artwork is mostly white thread, so
 * on a light card it loses its body and reads as a few black outlines; the app's
 * canvas is black, which is what it was drawn for.
 */

/** The eye in its slash. For anywhere the mark must survive being small. */
export function LogoGlyph({
  size = 42,
  className,
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/glyph.png"
      alt=""
      width={size}
      height={size}
      className={className}
      priority={priority}
      // Decorative in every place it is used: the product's name is always
      // written next to it, so a screen reader announcing "SherrByte logo"
      // beside the words "SherrByte Business" would just say it twice.
      aria-hidden="true"
    />
  );
}

/** The whole tear. For a page that has room to show it. */
export function LogoMark({
  height = 300,
  className,
  priority = false,
}: {
  height?: number;
  className?: string;
  priority?: boolean;
}) {
  // The source is 469 × 732, trimmed to its own content, so the ratio is fixed
  // here rather than left to the browser to work out from the file.
  const width = Math.round((height * 469) / 732);
  return (
    <Image
      src="/brand/mark.png"
      alt=""
      width={width}
      height={height}
      className={className}
      priority={priority}
      aria-hidden="true"
    />
  );
}

/**
 * Mark above the name, for a page that is otherwise bare.
 *
 * The sign-in and sign-up screens are a Clerk widget on an empty black field.
 * Someone who has followed a link there has no other confirmation of where they
 * are, which is the one place on the internet where that matters.
 */
export function LogoLockup({ subtitle }: { subtitle?: string }) {
  return (
    <div className={styles.lockup}>
      <LogoMark height={132} priority />
      <span className={styles.wordmark}>SherrByte</span>
      {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
    </div>
  );
}
