#!/usr/bin/env python3
"""生成站点用的得意黑子集（`assets/dizzy-sans.woff2`）。

**为什么要有这个脚本**：上游 `smiley-sans.woff2` 是 1.12 MB、9497 个字形的全量字体
（8335 个汉字 + 拉丁 / 希腊 / 西里尔 / 假名）。网页只用到其中一小撮字形，全量下载是
首屏最大的单笔开销（公网实测 2.2～5.3 秒）。子集化把这份开销砍到 ~15%。

**为什么字体改名**（`Smiley Sans` → `Dizzy Sans`）：OFL-1.1 条件 3 规定
「No Modified Version of the Font Software may use the Reserved Font Name(s)」，
而本字体的保留名是 `<Smiley>` 与 `<得意黑>`（见 `assets/LICENSE` 首行）。
子集化 = 删字形 = Modified Version，因此**必须**换名；OFL-FAQ 3.1 说得更直白：
「even if it is just a small change」。

保留的义务（都已做到）：
- 版权声明与 OFL 全文随字体分发 —— `assets/LICENSE` 原样不动；
- 派生版本仍以 OFL-1.1 发布 —— 见 `assets/NOTICE.md`；
- 不得用原作者名义推广 —— NOTICE 里只做事实陈述。

用法（在仓库根目录）：

    python packages/font-smiley/tools/build-subset.py

产物写进 `packages/font-smiley/assets/`。**产物要提交**：部署机上没有 Python / fontTools。
"""

from __future__ import annotations

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # packages/font-smiley
ROOT = os.path.dirname(os.path.dirname(HERE))                      # 仓库根
SOURCE = os.path.join(HERE, 'assets', 'smiley-sans.woff2')
TARGET = os.path.join(HERE, 'assets', 'dizzy-sans.woff2')

#: 子集的新名字。**不许**含 `Smiley` / `得意黑`（OFL 保留字体名）。
FAMILY = 'Dizzy Sans'
POSTSCRIPT = 'DizzySans-Regular'

#: 扫这些位置的全部文本，取「站点真的会渲染出来的字」。
SCAN_ROOTS = ['packages', 'docs']
SCAN_FILES = ['app.yml', 'AGENTS.md']
SCAN_SUFFIXES = ('.ts', '.md', '.yml', '.json', '.html', '.txt')
SKIP_DIR_PARTS = ('node_modules', 'assets/vendor', 'assets/lib', '.git', 'temp')

#: 与页面内容无关、但一定要有的字形：拉丁基础区、常用标点、CJK 标点、全角区。
ALWAYS = (
    [c for c in range(0x20, 0x7F)]      # 基本拉丁
    + [c for c in range(0xA0, 0x100)]   # 拉丁补充（° ± × ÷ 等）
    + [c for c in range(0x2013, 0x2015)]  # – — ―
    + [c for c in range(0x2018, 0x201F)]  # ‘ ’ “ ” „
    + [0x2026]                          # …
    + [0x20AC, 0x00A5]                  # € ¥
    + [c for c in range(0x2039, 0x203B)]
    + [c for c in range(0x2190, 0x2194)]  # ← ↑ → ↓
    + [0x2212, 0x2264, 0x2265, 0x2260, 0x00B7, 0x2261]
    + [c for c in range(0x3000, 0x3040)]  # CJK 标点（　、。《》「」【】…）
    + [c for c in range(0xFE30, 0xFE50)]  # CJK 兼容形式
    + [c for c in range(0xFF01, 0xFF61)]  # 全角 ASCII
    + [c for c in range(0xFFE0, 0xFFE6)]  # 全角 ¥ 等
)


def scan_chars() -> set[str]:
    """站点源码 / 文档里出现过的全部字符。"""
    chars: set[str] = set()
    for rel in SCAN_ROOTS:
        for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, rel)):
            normalized = dirpath.replace('\\', '/')
            if any(part in normalized for part in SKIP_DIR_PARTS):
                continue
            for name in filenames:
                if not name.endswith(SCAN_SUFFIXES):
                    continue
                try:
                    with open(os.path.join(dirpath, name), encoding='utf8') as handle:
                        chars |= set(handle.read())
                except (UnicodeDecodeError, OSError):
                    continue
    for rel in SCAN_FILES:
        try:
            with open(os.path.join(ROOT, rel), encoding='utf8') as handle:
                chars |= set(handle.read())
        except OSError:
            continue
    return chars


def pick_unicodes(source_cmap: set[int]) -> list[int]:
    wanted = set(ALWAYS) | {ord(ch) for ch in scan_chars()} | gb2312_level1()
    # 只保留源字体真有的码位；缺的（emoji 等）由 CSS 的字体栈回落，不算错。
    return sorted(cp for cp in wanted if cp in source_cmap)


def gb2312_level1() -> set[int]:
    """GB/T 2312 一级常用汉字（3755 个，0xB0A1–0xD7F9）。

    为什么要它：字体 `scope: all`，**页面上所有中文都用得意黑**，包括用户自己填的
    用户名、API key 名、上游账号标签。只取仓库源码里的字（1213 个）会让这些动态
    中文掉进系统字体，同一个名字里出现两种字形。一级字表覆盖现代中文 99.6% 的用字，
    代价 ~330 KB —— 比「全量 1.12 MB」便宜得多，比「只留源码字」安全得多。
    """
    chars: set[int] = set()
    for high in range(0xB0, 0xD8):
        for low in range(0xA1, 0xFF):
            try:
                ch = bytes([high, low]).decode('gb2312')
            except UnicodeDecodeError:
                continue
            if 0x4E00 <= ord(ch) <= 0x9FFF:
                chars.add(ord(ch))
    return chars


def rename(font: TTFont) -> None:
    """把 font name 表里的保留字体名换掉（OFL 条件 3），其余元数据原样保留。"""
    family = FAMILY
    full = FAMILY
    ps = POSTSCRIPT
    unique = f'{FAMILY}; subset by DizzyAPI'
    for record in font['name'].names:
        if record.nameID == 1:
            record.string = family.encode(record.getEncoding(), errors='replace')
        elif record.nameID == 3:
            record.string = unique.encode(record.getEncoding(), errors='replace')
        elif record.nameID == 4:
            record.string = full.encode(record.getEncoding(), errors='replace')
        elif record.nameID == 6:
            record.string = ps.encode(record.getEncoding(), errors='replace')
        elif record.nameID == 16:
            record.string = family.encode(record.getEncoding(), errors='replace')
        # nameID 0 / 7 / 8 / 9 / 11 / 12 / 13 / 14 是版权、商标、厂商、许可、
        # URL、设计者、许可说明：**全部原样保留**（OFL 条件 2 要求随字体携带）。


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f'缺源字体：{SOURCE}', file=sys.stderr)
        return 1
    font = TTFont(SOURCE)
    cmap = set(font.getBestCmap())
    unicodes = pick_unicodes(cmap)
    cjk = sum(1 for cp in unicodes if 0x4E00 <= cp <= 0x9FFF)
    print(f'源字体字形 {font["maxp"].numGlyphs}，收录码位 {len(unicodes)}（汉字 {cjk}）')

    options = subset.Options()
    options.flavor = 'woff2'
    # 站点真的用到的排版特性：等宽数字（表格）、连字与上下标、字距。
    options.layout_features = ['kern', 'tnum', 'pnum', 'frac', 'sups', 'ccmp', 'calt', 'locl']
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    options.drop_tables += ['DSIG']
    options.notdef_outline = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    rename(font)
    font.flavor = 'woff2'
    font.save(TARGET)

    before = os.path.getsize(SOURCE)
    after = os.path.getsize(TARGET)
    print(f'{SOURCE} {before} B → {TARGET} {after} B（{(after / before) * 100:.1f}%）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
