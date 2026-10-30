#!/usr/bin/env python3
"""生成 Eagle 素材导入助手 的 PNG 图标（无需第三方库）。
用法: python3 gen_icons.py
输出: icons/icon16.png  icon48.png  icon128.png
"""
import zlib
import struct
import os


def write_png(path, size, rgba):
    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * size * 4:(y + 1) * size * 4])
    idat = zlib.compress(bytes(raw), 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))


def make_icon(size):
    rgba = bytearray(size * size * 4)

    def setpx(x, y, r, g, b, a=255):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            rgba[i] = r
            rgba[i + 1] = g
            rgba[i + 2] = b
            rgba[i + 3] = a

    def round_rect(x, y, x0, y0, x1, y1, r):
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        if x < x0 + r and y < y0 + r:
            return (x - (x0 + r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
        if x > x1 - r and y < y0 + r:
            return (x - (x1 - r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
        if x < x0 + r and y > y1 - r:
            return (x - (x0 + r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
        if x > x1 - r and y > y1 - r:
            return (x - (x1 - r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
        return True

    def in_triangle(px, py, ax, ay, bx, by, cx, cy):
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if d == 0:
            return False
        a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
        b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
        c = 1 - a - b
        return 0 <= a <= 1 and 0 <= b <= 1 and 0 <= c <= 1

    for y in range(size):
        for x in range(size):
            # 背景：蓝色圆角方块，顶部到底部渐变
            if round_rect(x, y, 0, 0, size - 1, size - 1, size * 0.2):
                t = y / size
                r = int(79 + (46 - 79) * t)
                g = int(141 + (91 - 141) * t)
                b = int(253 + (255 - 253) * t)
                setpx(x, y, r, g, b)
            else:
                setpx(x, y, 0, 0, 0, 0)

    # 内部白色卡片
    m = size * 0.2
    card_r = size * 0.12
    for y in range(size):
        for x in range(size):
            if round_rect(x, y, m, m, size - 1 - m, size - 1 - m, card_r):
                # 山：两个蓝色三角形
                in_mountain = (
                    in_triangle(x, y, m, size - m, size * 0.5, size * 0.52, size * 0.74, size - m)
                    or in_triangle(x, y, size * 0.55, size - m, size * 0.82, size * 0.58, size - m, size - m)
                )
                # 太阳：右上黄色圆
                sx, sy, sr = size * 0.68, size * 0.34, size * 0.1
                in_sun = (x - sx) ** 2 + (y - sy) ** 2 <= sr * sr
                if in_sun:
                    setpx(x, y, 255, 209, 102)
                elif in_mountain:
                    setpx(x, y, 79, 141, 253)
                else:
                    setpx(x, y, 255, 255, 255)
    return rgba


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        rgba = make_icon(s)
        write_png(os.path.join(out_dir, f'icon{s}.png'), s, rgba)
        print('generated icons/icon%d.png' % s)


if __name__ == '__main__':
    main()
