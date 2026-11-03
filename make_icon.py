# -*- coding: utf-8 -*-
"""生成「译读」应用图标（多尺寸 ICO + 预览图）。

设计：深墨绿圆角方块 + 奶油色摊开的书 + 薄荷色“翻译灵感”星芒。
所有尺寸从同一张 2048px 母版缩放，保证 16px 下也有清晰轮廓。
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 2048
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---- 品牌色 ----
INK_TOP = (23, 98, 78)       # #17624E
INK_BOTTOM = (8, 43, 37)     # #082B25
PAPER = (248, 241, 226)      # #F8F1E2
PAPER_EDGE = (218, 205, 181) # #DACDB5
INK_LINE = (117, 158, 140)   # #759E8C
MINT = (111, 231, 174)       # #6FE7AE
GOLD = (244, 201, 93)        # #F4C95D
DEEP = (16, 66, 52)          # #104234


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    """左上到右下的斜向渐变。"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (x + y) / (2.0 * (size - 1))
    t = np.clip(t, 0, 1)[..., None]
    top = np.array(INK_TOP, dtype=np.float32)
    bottom = np.array(INK_BOTTOM, dtype=np.float32)
    arr = top * (1 - t) + bottom * t
    return Image.fromarray(arr.astype(np.uint8), "RGB")


def radial_glow(size: int, cx: float, cy: float, radius: float,
                color: tuple[int, int, int], alpha: int) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    dist = np.sqrt((x - cx * size) ** 2 + (y - cy * size) ** 2) / (radius * size)
    a = np.clip(1 - dist, 0, 1) ** 2 * alpha
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[..., 0] = color[0]
    arr[..., 1] = color[1]
    arr[..., 2] = color[2]
    arr[..., 3] = a.astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def capsule(draw: ImageDraw.ImageDraw, p1, p2, width: int, fill):
    x1, y1 = p1
    x2, y2 = p2
    draw.line((x1, y1, x2, y2), fill=fill, width=width)
    r = width / 2
    for x, y in ((x1, y1), (x2, y2)):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)


def star_points(cx: float, cy: float, outer: float, inner: float):
    pts = []
    for i in range(8):
        ang = -np.pi / 2 + i * np.pi / 4
        r = outer if i % 2 == 0 else inner
        pts.append((cx + r * np.cos(ang), cy + r * np.sin(ang)))
    return pts


def build(with_letters: bool = True) -> Image.Image:
    base = gradient(S).convert("RGBA")
    base.alpha_composite(radial_glow(S, 0.24, 0.18, 0.70, (58, 160, 126), 70))
    base.alpha_composite(radial_glow(S, 0.82, 0.86, 0.62, (3, 24, 20), 120))

    # 圆角方块 + 细内描边
    mask = rounded_mask(S, S * 0.225)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)
    d = ImageDraw.Draw(icon)
    d.rounded_rectangle((S * 0.012, S * 0.012, S * 0.988, S * 0.988),
                        radius=S * 0.216, outline=(255, 255, 255, 14), width=int(S * 0.004))

    # ---- 书下方柔和阴影 ----
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.polygon([(0.50 * S, 0.415 * S), (0.185 * S, 0.480 * S),
                (0.185 * S, 0.735 * S), (0.50 * S, 0.680 * S),
                (0.815 * S, 0.735 * S), (0.815 * S, 0.480 * S)],
               fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.022))
    icon.alpha_composite(shadow, (0, int(S * 0.018)))

    # ---- 书页厚度（底层，向下错开一点） ----
    thickness = (214, 199, 173, 255)
    d.polygon([(0.50 * S, 0.432 * S), (0.185 * S, 0.495 * S),
               (0.185 * S, 0.725 * S), (0.50 * S, 0.670 * S),
               (0.815 * S, 0.725 * S), (0.815 * S, 0.495 * S)],
              fill=thickness)

    # ---- 左右书页 ----
    left = [(0.50 * S, 0.418 * S), (0.195 * S, 0.475 * S),
            (0.195 * S, 0.702 * S), (0.50 * S, 0.650 * S)]
    right = [(0.50 * S, 0.418 * S), (0.805 * S, 0.475 * S),
             (0.805 * S, 0.702 * S), (0.50 * S, 0.650 * S)]
    d.polygon(left, fill=PAPER)
    d.polygon(right, fill=PAPER)

    # 书页内侧的淡阴影（靠书脊处更深一点）
    shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh = ImageDraw.Draw(shade)
    sh.polygon([(0.50 * S, 0.418 * S), (0.43 * S, 0.432 * S),
                (0.43 * S, 0.665 * S), (0.50 * S, 0.650 * S)],
               fill=(120, 96, 62, 34))
    sh.polygon([(0.50 * S, 0.418 * S), (0.57 * S, 0.432 * S),
                (0.57 * S, 0.665 * S), (0.50 * S, 0.650 * S)],
               fill=(120, 96, 62, 34))
    shade = shade.filter(ImageFilter.GaussianBlur(S * 0.006))
    icon.alpha_composite(shade)

    # ---- 书脊 ----
    d.line((0.50 * S, 0.420 * S, 0.50 * S, 0.650 * S),
           fill=(176, 159, 128, 200), width=int(S * 0.006))

    # ---- 页面文字 ----
    line_color = (117, 158, 140, 150)
    for i, y in enumerate((0.500, 0.540, 0.690)):
        inset = 0.0 if i < 2 else 0.022
        capsule(d, (0.270 * S, y * S), (0.455 * S - inset * S, (y - 0.022) * S),
                int(S * 0.016), line_color)
        capsule(d, (0.730 * S, y * S), (0.545 * S + inset * S, (y - 0.022) * S),
                int(S * 0.016), line_color)

    if with_letters:
        # 左页 A（英文），右页 文（中文），点出“英 → 中”的产品含义。
        try:
            font_en = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", int(S * 0.105))
            font_zh = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", int(S * 0.090))
            d.text((0.360 * S, 0.605 * S), "A", font=font_en, fill=DEEP, anchor="mm")
            d.text((0.643 * S, 0.605 * S), "文", font=font_zh, fill=DEEP, anchor="mm")
        except OSError:
            pass

    # ---- 翻译星芒 ----
    # 主星（薄荷绿）
    d.polygon(star_points(0.755 * S, 0.300 * S, 0.088 * S, 0.021 * S), fill=MINT)
    d.ellipse((0.755 * S - 0.018 * S, 0.300 * S - 0.018 * S,
               0.755 * S + 0.018 * S, 0.300 * S + 0.018 * S), fill=(255, 255, 255, 220))
    # 副星（暖金）
    d.polygon(star_points(0.668 * S, 0.238 * S, 0.034 * S, 0.009 * S), fill=GOLD)

    # 底部极淡的暖光，避免下半部分太闷
    icon.alpha_composite(radial_glow(S, 0.50, 0.78, 0.45, (241, 190, 104), 18))

    return icon


def main() -> None:
    master = build(with_letters=True)
    master.save(os.path.join(OUT_DIR, "icon-master.png"))
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon-512.png"))

    # 多尺寸 ICO（Windows 会按 DPI 自动挑最合适的一档）
    sizes = [256, 128, 96, 64, 48, 40, 32, 24, 20, 16]
    frames = [master.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[0].save(
        os.path.join(OUT_DIR, "icon-new.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[1:],
    )

    # 小尺寸对照图：深色 / 浅色背景上各排一行
    sheet = Image.new("RGB", (900, 420), (35, 37, 42))
    sd = ImageDraw.Draw(sheet)
    sd.rectangle((0, 0, 900, 209), fill=(245, 245, 243))
    x = 30
    for s in (256, 128, 64, 48, 32, 24, 16):
        im = master.resize((s, s), Image.LANCZOS)
        for row in (0, 210):
            y = row + (209 - s) // 2 if s < 190 else row + 10
            sheet.paste(im, (x, y), im)
        x += max(s, 48) + 30
    sheet.save(os.path.join(OUT_DIR, "icon-sheet.png"))

    # 无字母版本，方便对比
    alt = build(with_letters=False)
    alt.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon-alt-512.png"))
    print("done")


if __name__ == "__main__":
    main()

