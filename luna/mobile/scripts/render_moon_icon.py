#!/usr/bin/env python3
"""Rasterize the centered Luna moon (no frame) for legacy launcher mipmaps."""

from pathlib import Path

import cairosvg

ROOT = Path(__file__).resolve().parents[1] / "app" / "src" / "main" / "res"

# Same path as drawable/ic_launcher_foreground.xml, plus a black plate so
# older launchers that ignore the adaptive XML still show a moon.
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <rect width="108" height="108" fill="#000"/>
  <path d="M54 36a12 12 0 0 0 18 18 18 18 0 1 1-18-18Z" fill="none"
        stroke="#fff" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def main() -> None:
    sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, px in sizes.items():
        out_dir = ROOT / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        png = cairosvg.svg2png(bytestring=SVG.encode(), output_width=px, output_height=px)
        (out_dir / "ic_launcher.png").write_bytes(png)
        (out_dir / "ic_launcher_round.png").write_bytes(png)
        print(out_dir, px)


if __name__ == "__main__":
    main()
