# -*- coding: utf-8 -*-
"""生成图标：深色底 + 2×2 棋盘，左上绿（确定宝藏）右下红（确定炸弹）。

  用 overlay venv 的 python 跑：python 生成图标.py

为什么自己画：PyInstaller 默认图标是个通用 Python 图标，混在桌面上一眼认不出。
小尺寸下能看清的只有"大色块"，所以不做细节，只保留四个格子。
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 512
BG = (15, 23, 42)
CELL = {
    (0, 0): (21, 128, 61),        # 确定宝藏 —— 绿
    (0, 1): (253, 230, 138),      # 未知 —— 米黄
    (1, 0): (253, 230, 138),
    (1, 1): (185, 28, 28),        # 确定炸弹 —— 红
}
PAD = 52
GAP = 16

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=96, fill=BG)

inner = S - 2 * PAD
cw = (inner - GAP) // 2
for (r, c), col in CELL.items():
    x0 = PAD + c * (cw + GAP)
    y0 = PAD + r * (cw + GAP)
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + cw], radius=34, fill=col)

# 外圈描一道淡边，深色桌面上不至于糊掉
d.rounded_rectangle([3, 3, S - 4, S - 4], radius=93, outline=(125, 211, 252, 200), width=6)

out = os.path.join(HERE, '图标.ico')
img.save(out, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
img.save(os.path.join(HERE, '图标.png'))
print('图标已生成：%s  %d 字节' % (out, os.path.getsize(out)))
