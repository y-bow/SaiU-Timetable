#!/usr/bin/env python3
"""Generate the iOS launch images referenced by index.html.

iOS shows one of these from the moment the home-screen icon is tapped until
the page's first paint. Without them the launch screen is blank white, which
on a dark app reads as a flash before the boot layer appears.

Each image is a solid canvas in the app's dark background with the wordmark
centred, so the sequence is: OS launch image -> boot layer -> app. Because the
launch image and the boot layer share a background and a centred mark, the
transition has nothing to visibly snap to.

The mark colour is white to match the app's default dark theme. The manifest
background_color is likewise #000000; iOS does not re-read it per user theme,
so a light-theme user sees a dark launch image that cross-fades into the boot
layer's light canvas. That is a soft transition rather than a flash, which is
the best achievable with a static startup image.

Run from the repo root:  python3 scripts/gen-startup-images.py
Requires Pillow. Output is deterministic, so re-running produces no diff.
"""

from __future__ import annotations

import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "icons" / "startup"
MARK = ROOT / "icons" / "app" / "white-icon-512.png"

# Matches style.css `--bg` for the default dark theme, and manifest.json's
# background_color.
BACKGROUND = (0, 0, 0, 255)

# Fraction of the shorter edge the mark occupies. Apple HIGs suggest the mark
# sit around 20-25% of the width; the boot layer uses 76px on a 375pt screen,
# which is ~20%, so this keeps the two images visually consistent.
MARK_SCALE = 0.20

# (width, height) of the emitted PNGs. These are the *pixel* dimensions, i.e.
# CSS points multiplied by the device pixel ratio, which is what Safari
# matches on. The pairs are chosen to cover the iPhones in active use:
# SE/8 (2x), X/XS/11 Pro/12 mini (2x-3x), 12/13/14 (3x), 14 Pro/15/15 Pro/16
# (3x), 16 Pro (3x), plus landscape rotations.
SIZES = [
    (640, 1136),   # iPhone SE / 5s / 8          portrait  @2x 320x568
    (750, 1334),   # iPhone 6/7/8/SE2/11 Pro     portrait  @2x 375x667
    (828, 1792),   # iPhone XR/11                 portrait  @2x 414x896
    (1170, 2532),  # iPhone 12/13/14              portrait  @3x 390x844
    (1179, 2556),  # iPhone 14 Pro                portrait  @3x 393x852
    (1284, 2778),  # iPhone 12/13 Pro Max/14 Plus portrait  @3x 428x926
    (1290, 2796),  # iPhone 14 Pro Max/15/16 Pro  portrait  @3x 430x932
    (1334, 750),   # iPhone 6/7/8/11 Pro          landscape @2x
    (2532, 1170),  # iPhone 12/13/14              landscape @3x
    (2778, 1284),  # iPhone 12/13 Pro Max/14 Plus landscape  @3x
]


def render(width: int, height: int, mark: Image.Image) -> Image.Image:
    """Solid themed canvas with the mark optically centred."""
    canvas = Image.new("RGBA", (width, height), BACKGROUND)

    # Scale relative to the shorter edge so the mark keeps the same visual
    # weight whether the image is a tall phone or a short landscape one.
    side = int(min(width, height) * MARK_SCALE)
    resized = mark.resize((side, side), Image.LANCZOS)
    canvas.alpha_composite(
        resized,
        ((width - side) // 2, (height - side) // 2),
    )
    return canvas


def main() -> None:
    if not MARK.is_file():
        raise SystemExit(f"missing mark asset: {MARK}")

    with Image.open(MARK) as src:
        # Normalise to RGBA square so compositing works regardless of how the
        # source asset happens to be encoded.
        mark = src.convert("RGBA")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    for width, height in SIZES:
        target = OUT_DIR / f"startup-{width}x{height}.png"
        image = render(width, height, mark)
        # optimize=True keeps the files small; they are only ever decoded once
        # at launch, so file size matters more than encode speed.
        image.save(target, "PNG", optimize=True)
        written += 1
        print(f"[startup] {target.relative_to(ROOT)} ({width}x{height})")

    print(f"[startup] wrote {written} launch images to {OUT_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()