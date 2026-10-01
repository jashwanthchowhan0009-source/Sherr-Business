# The mark

Two source files, committed here and not served:

| File | What it is |
|---|---|
| `logo-source-transparent.png` | 1076 × 1080 RGBA, real transparency. Everything below is cut from this one. |
| `logo-source-dark.jpg` | The same artwork flattened onto black. Kept as the reference for how it is meant to look; nothing is generated from it. |

The artwork is a tiger's eye behind four torn claw marks, embroidered. It is
**mostly white thread**, so it belongs on a dark surface: on a light card the
white body disappears and what is left reads as a few black outlines. The app's
canvas is black, which is what it was drawn for.

## What is generated from it

Two shapes, because the full mark does not survive being made small. It is
469 × 732 of claw; at the 42px of the top bar that is a grey smudge, and the eye
— the only part anybody recognises — is six pixels of nothing.

| Generated | Size | Where it is used |
|---|---|---|
| `public/brand/mark.png` | 469 × 732 | The landing hero, the sign-in lockup |
| `public/brand/mark-360.png` | 231 × 360 | The 1× of the above |
| `public/brand/glyph.png` | 256 × 256 | The top bar, the MFA gate, the manifest |
| `public/brand/icon-maskable.png` | 512 × 512 | Android's maskable launcher icon |
| `src/app/icon.png` | 256 × 256 | The favicon (Next file convention) |
| `src/app/apple-icon.png` | 180 × 180 | The iOS home-screen icon |
| `src/app/opengraph-image.png` | 1200 × 630 | Link previews |

The **glyph** is a 370px square crop of the source centred on (571, 517), the
middle of the eye. That keeps the eye and the slash it looks through, and drops
the outer claws that turn to mush at small sizes. The eye still reads at 16px.

The **icons** are composited onto the app's own `#0a0a0c` rather than left
transparent: a favicon sits on browser chrome that may be light or dark, and
white thread on a light tab strip is invisible. The maskable one is inset to 60%
because a launcher crops to the inner 80% at most, and to whatever shape it likes.

## Regenerating

Pillow only, and only when the artwork changes:

```bash
pip install Pillow
python3 - <<'PY'
from PIL import Image
src = Image.open("brand/logo-source-transparent.png").convert("RGBA")
mark = src.crop(src.getbbox())                       # trim the empty padding
glyph = src.crop((571-185, 517-185, 571+185, 517+185))  # square, on the eye

def save(im, path, maxpx=None):
    out = im.copy()
    if maxpx:
        out.thumbnail((maxpx, maxpx), Image.LANCZOS)
    # 255 colours is visually lossless on embroidery — a few hundred threads,
    # not a photograph — and roughly quarters the bytes. Alpha survives.
    out.quantize(colors=255, method=Image.FASTOCTREE).save(path, optimize=True)

save(mark, "public/brand/mark.png", 732)
save(mark, "public/brand/mark-360.png", 360)
save(glyph, "public/brand/glyph.png", 256)

def tile(size, pad):
    out = Image.new("RGBA", (size, size), (10, 10, 12, 255))
    inner = int(size * (1 - pad * 2))
    out.alpha_composite(glyph.resize((inner, inner), Image.LANCZOS), (int(size*pad),)*2)
    return out

save(tile(256, 0.10), "src/app/icon.png")
save(tile(180, 0.10), "src/app/apple-icon.png")
save(tile(512, 0.20), "public/brand/icon-maskable.png")
PY
```

The Open Graph image is composed in the same way, with the wordmark set in
`src/lib/pdf/fonts/invoice-{bold,regular}.ttf` — the faces the invoice PDF uses,
so a shared link and a printed invoice are set in one typeface rather than two.

## Where the mark is deliberately absent

**Invoice PDFs.** Those carry the issuing company's own identity. Printing
SherrByte's mark on somebody's tax invoice would put our brand on their legal
document, which is not ours to do.

**Exported CSV and JSON.** They are data for a spreadsheet or a portal utility to
read, and a banner line is one more row for the reader to skip past.
