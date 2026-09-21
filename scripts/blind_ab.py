#!/usr/bin/env python3
"""
Build a blind A/B sheet for a critic.

The gauntlet only works if the comparison is genuinely blind. Asking an agent to
"compare ours against the reference" tells it which is which, and it will flatter
ours. This stacks the two images into one sheet, labels them only A and B, and
randomises which side is ours. The answer key is written to a separate file the
critic never sees.

    python3 scripts/blind_ab.py --ours captures/halfpipe.png \
        --ref refs/olliolli/olliolli-grind-rail-pink-sunset-13.png \
        --out review/halfpipe-ab.png --key review/halfpipe.key.json
"""
import argparse
import json
import os
import pathlib
import secrets

from PIL import Image, ImageDraw, ImageFont

GUTTER = 14
PAD = 18
LABEL_H = 54
BG = (22, 18, 34)
INK = (236, 230, 220)


def load_scaled(path: str, target_h: int) -> Image.Image:
    img = Image.open(path).convert("RGB")
    w = round(img.width * target_h / img.height)
    return img.resize((w, target_h), Image.LANCZOS)


def label_font(size: int):
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                pass
    return ImageFont.load_default()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True)
    ap.add_argument("--ref", required=True, nargs="+",
                    help="one or more reference images; one is chosen at random")
    ap.add_argument("--out", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--height", type=int, default=760)
    args = ap.parse_args()

    ref_path = secrets.choice(args.ref)
    ours = load_scaled(args.ours, args.height)
    ref = load_scaled(ref_path, args.height)

    # Coin flip decides which panel is ours. secrets, not random, so a seeded
    # run can never accidentally make this predictable.
    ours_left = secrets.randbelow(2) == 0
    left, right = (ours, ref) if ours_left else (ref, ours)

    width = PAD * 2 + left.width + GUTTER + right.width
    height = PAD * 2 + LABEL_H + args.height
    sheet = Image.new("RGB", (width, height), BG)
    sheet.paste(left, (PAD, PAD + LABEL_H))
    sheet.paste(right, (PAD + left.width + GUTTER, PAD + LABEL_H))

    draw = ImageDraw.Draw(sheet)
    font = label_font(34)
    draw.text((PAD + left.width // 2, PAD + 10), "A", fill=INK, font=font, anchor="ma")
    draw.text((PAD + left.width + GUTTER + right.width // 2, PAD + 10), "B",
              fill=INK, font=font, anchor="ma")

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)

    key = pathlib.Path(args.key)
    key.parent.mkdir(parents=True, exist_ok=True)
    key.write_text(json.dumps({
        "A": "ours" if ours_left else "reference",
        "B": "reference" if ours_left else "ours",
        "ours_path": args.ours,
        "reference_path": ref_path,
    }, indent=2))
    print(f"sheet {out}  ({sheet.width}x{sheet.height})")
    print(f"key   {key}  [not for the critic]")


if __name__ == "__main__":
    main()
