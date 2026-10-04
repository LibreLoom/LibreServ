#!/usr/bin/env python3
"""Rasterize the centered Luna logo (no frame) for legacy launcher mipmaps."""

from pathlib import Path

import cairosvg

ROOT = Path(__file__).resolve().parents[1] / "app" / "src" / "main" / "res"

# Same shapes as drawable/ic_launcher_foreground.xml, plus a black plate so
# older launchers that ignore the adaptive XML still show the logo.
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <rect width="108" height="108" fill="#000"/>
  <g transform="translate(6 6) scale(0.4)" fill="#fff">
    <path d="M88.00 44.74 L88.00 99.70 A48 48 0 0 0 136.00 147.70 L197.11 147.70 A3.0 3.0 0 0 1 199.90 151.81 A86.0 86.0 0 1 1 83.73 42.02 A3.0 3.0 0 0 1 88.00 44.74Z"/>
    <circle cx="136" cy="99.7" r="30"/>
  </g>
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
