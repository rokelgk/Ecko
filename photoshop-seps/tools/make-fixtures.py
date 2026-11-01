"""Builds the test artwork in test/fixtures (run once; outputs are committed)."""
import math, os
from PIL import Image, ImageDraw, ImageFilter

out = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(out, exist_ok=True)

# A soft-shaded, photo-like design on transparency: gradient sky disc,
# shaded orange sphere, green leaves, a small bright red accent, white highlights.
W = H = 360
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
for r in range(170, 0, -1):
    t = r / 170
    d.ellipse([180 - r, 180 - r, 180 + r, 180 + r], fill=(int(30 + 60 * t), int(90 + 80 * (1 - t)), int(200 - 40 * t), 255))
sphere = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(sphere)
for r in range(90, 0, -1):
    t = r / 90
    sd.ellipse([170 - r - (1 - t) * 30, 190 - r - (1 - t) * 30, 170 + r - (1 - t) * 30, 190 + r - (1 - t) * 30],
               fill=(int(255 - 90 * t), int(200 - 120 * t), int(80 - 60 * t), 255))
img = Image.alpha_composite(img, sphere)
d = ImageDraw.Draw(img)
for i in range(5):
    a = i * 1.2
    cx, cy = 250 + 50 * math.cos(a), 110 + 30 * math.sin(a)
    d.ellipse([cx - 22, cy - 10, cx + 22, cy + 10], fill=(40, 150, 60, 255))
d.ellipse([92, 92, 104, 104], fill=(230, 10, 30, 255))  # tiny red accent
d.ellipse([130, 140, 150, 160], fill=(255, 255, 255, 255))  # highlight
img = img.filter(ImageFilter.GaussianBlur(0.8))
img.save(os.path.join(out, 'sim-art.png'), dpi=(150, 150))

# Flat logo: three solid colors with anti-aliased edges on white.
logo = Image.new('RGB', (300, 200), (255, 255, 255))
ld = ImageDraw.Draw(logo)
ld.rectangle([20, 20, 140, 180], fill=(0, 51, 160))
ld.ellipse([150, 30, 280, 170], fill=(218, 41, 28))
ld.polygon([(80, 40), (120, 160), (40, 160)], fill=(255, 199, 44))
logo = logo.resize((600, 400), Image.LANCZOS).resize((300, 200), Image.LANCZOS)
logo.save(os.path.join(out, 'logo.png'), dpi=(150, 150))

# Gray ramp for tone tests.
ramp = Image.new('L', (256, 40))
for x in range(256):
    for y in range(40):
        ramp.putpixel((x, y), x)
ramp.save(os.path.join(out, 'ramp.png'), dpi=(300, 300))
