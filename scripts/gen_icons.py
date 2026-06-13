"""生成插件图标：橙红渐变圆角底 + 白色聊天气泡 + 下载箭头。

用法: ./.venv/bin/python scripts/gen_icons.py
输出: extension/icons/icon{16,32,48,128}.png 以及 512 原图
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 512  # 画布尺寸

C1 = (255, 138, 61)   # #ff8a3d
C2 = (255, 94, 98)    # #ff5e62


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(C1, C2, t)
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_icon():
    bg = gradient_bg(S)
    mask = rounded_mask(S, int(S * 0.225))  # 接近 squircle 的大圆角
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)

    # 聊天气泡主体（白色圆角矩形 + 左下角小尾巴）
    bx0, by0, bx1, by1 = int(S * 0.17), int(S * 0.20), int(S * 0.83), int(S * 0.68)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(S * 0.12), fill=white)
    d.polygon(
        [
            (int(S * 0.28), by1 - int(S * 0.02)),
            (int(S * 0.24), int(S * 0.82)),
            (int(S * 0.44), by1 - int(S * 0.02)),
        ],
        fill=white,
    )

    # 气泡内的下载箭头（渐变中点色），象征“备份落盘”
    arrow = lerp(C1, C2, 0.5) + (255,)
    cx = (bx0 + bx1) // 2
    top, bottom = int(S * 0.295), int(S * 0.50)
    w = int(S * 0.042)  # 线宽
    d.line([(cx, top), (cx, bottom)], fill=arrow, width=w)
    head = int(S * 0.085)
    d.line([(cx - head, bottom - head), (cx, bottom)], fill=arrow, width=w)
    d.line([(cx + head, bottom - head), (cx, bottom)], fill=arrow, width=w)
    # 箭头线端圆头
    r = w // 2
    for (px_, py_) in [(cx, top), (cx, bottom), (cx - head, bottom - head), (cx + head, bottom - head)]:
        d.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill=arrow)
    # 底部托盘横线
    ty = int(S * 0.575)
    tw = int(S * 0.16)
    d.line([(cx - tw, ty), (cx + tw, ty)], fill=arrow, width=w)
    for px_ in (cx - tw, cx + tw):
        d.ellipse([px_ - r, ty - r, px_ + r, ty + r], fill=arrow)

    return icon


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon = draw_icon()
    icon.save(OUT / "icon512.png")
    for size in (128, 48, 32, 16):
        icon.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
