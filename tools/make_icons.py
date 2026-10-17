"""Draws the extension icon: three routes meeting at one point. Run: python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=110, fill="#1976d2")
M = (262, 250)
routes = [
    ("#ff6b6b", [(84, 120), (170, 150), M, (360, 330), (430, 430)]),
    ("#ffffff", [(70, 400), (160, 330), M, (330, 160), (440, 96)]),
    ("#7ee081", [(250, 450), (240, 350), M, (380, 230), (450, 250)]),
]
for color, pts in routes:
    d.line(pts, fill=color, width=34, joint="curve")
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - 26, p[1] - 26, p[0] + 26, p[1] + 26], fill=color)
r = 62
d.ellipse([M[0] - r - 14, M[1] - r - 14, M[0] + r + 14, M[1] + r + 14], fill="#1976d2")
d.ellipse([M[0] - r, M[1] - r, M[0] + r, M[1] + r], fill="#fde047")
d.ellipse([M[0] - 24, M[1] - 24, M[0] + 24, M[1] + 24], fill="#111827")
out = Path(__file__).resolve().parent.parent / "src" / "icons"
for n in (16, 32, 48, 96, 128):
    img.resize((n, n), Image.LANCZOS).save(out / f"icon-{n}.png")
print("ok")
