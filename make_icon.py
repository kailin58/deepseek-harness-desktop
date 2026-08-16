"""生成 DeepSeek Harness 桌面版应用图标 app-icon.ico（多尺寸）。

设计：深蓝->近黑径向渐变圆 + 中心白色"对话气泡"+蓝色三点（AI 输入中），
科技、简洁、在桌面小尺寸下仍清晰。
"""
from PIL import Image, ImageDraw
import ctypes
from ctypes import wintypes

OUT = r"E:\deepseek-harness-desktop\app-icon.ico"
SIZES = [16, 32, 48, 64, 128, 256]


def lerp(a, b, t):
    return tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))


def make_logo(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    R = size * 0.47

    # 径向渐变背景（从外暗到内亮的多层同心圆）
    outer = (12, 16, 24)
    inner = (37, 99, 191)
    steps = max(24, size // 3)
    for i in range(steps):
        t = i / steps
        r = R * (1 - 0.94 * t)
        col = lerp(outer, inner, t) + (255,)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)

    # 顶部高光
    d.ellipse([cx - R * 0.92, cy - R * 0.92, cx + R * 0.92, cy + R * 0.1],
              fill=(255, 255, 255, 18))

    # 白色对话气泡
    bw = size * 0.52
    bh = size * 0.40
    bx1 = cx - bw / 2
    by1 = cy - bh / 2 - size * 0.03
    bx2 = cx + bw / 2
    by2 = cy + bh / 2 - size * 0.03
    rad = size * 0.13
    d.rounded_rectangle([bx1, by1, bx2, by2], radius=rad, fill=(245, 248, 255, 255))

    # 气泡尾巴
    tw = size * 0.20
    tail = [
        (cx - tw / 2, by2 - 1),
        (cx - tw * 0.15, by2 + size * 0.16),
        (cx + tw * 0.30, by2 - 1),
    ]
    d.polygon(tail, fill=(245, 248, 255, 255))

    # 三点（蓝色，表示 AI 输入中）
    dot_r = max(1.2, size * 0.048)
    dot_col = (37, 99, 191, 255)
    my = cy - size * 0.03
    for k in range(3):
        dx = cx + (k - 1) * size * 0.135
        d.ellipse([dx - dot_r, my - dot_r, dx + dot_r, my + dot_r], fill=dot_col)

    return img


def main():
    frames = [make_logo(s) for s in SIZES]
    # 大图先轻微锐化
    frames[-1] = frames[-1].filter(Image.Resampling.BICUBIC) if False else frames[-1]
    frames[0].save(OUT, sizes=[(s, s) for s in SIZES])
    print("ICO 已生成:", OUT)

    # 打印桌面真实路径，供创建快捷方式使用
    buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
    ctypes.windll.shell32.SHGetFolderPathW(0, 0x10, 0, 0, buf)
    print("DESKTOP=", buf.value)


if __name__ == "__main__":
    main()
