# 字体改动说明（OFL-1.1）

本站自托管的站点字体是**得意黑（Smiley Sans）v2.0.1 的子集**，不是上游原版文件。

## 上游

- 字体：Smiley Sans / 得意黑 v2.0.1
- 作者：atelierAnchor <https://atelier-anchor.com>
- 许可：SIL Open Font License 1.1（全文见同目录 `LICENSE`，原样保留，未改动一字节）
- 声明保留字体名（Reserved Font Names）：`Smiley`、`得意黑`

## 本站做的改动

1. **子集化**：只保留站点用得到的码位（基本拉丁、常用标点、CJK 标点、全角区、
   GB/T 2312 一级常用汉字，以及仓库源码 / 文档里出现过的全部字符），
   9497 个字形 → 4156 个，1,150,924 B → 507,880 B。
   生成脚本：`../tools/build-subset.py`（可重跑）。
2. **改名**：字体家族名 `Smiley Sans` → `Dizzy Sans`，PostScript 名 `DizzySans-Regular`。
   理由：OFL-1.1 条件 3 规定 Modified Version 不得使用保留字体名；
   OFL-FAQ 3.1 明确「even if it is just a small change」也要改。
   **只改了主名字段**（nameID 1 / 3 / 4 / 6 / 16）。

## 原样保留的义务

- `LICENSE` 全文（含版权行与保留字体名声明）——未改动。
- 字体 name 表里的版权声明（nameID 0）、设计者（9）、厂商（8）、
  许可说明（13）、许可 URL（14）——未改动。
- 派生版本仍以 SIL OFL-1.1 发布；不得单独售卖；不得用原作者名义推广。
- 上游项目：<https://github.com/atelier-anchor/smiley-sans>

## 重新生成

改了页面文案（新增了子集里没有的汉字）之后：

```bash
python packages/font-smiley/tools/build-subset.py
```

产物 `dizzy-sans.woff2` **要提交**——部署机上没有 Python / fontTools，
生成不发生在构建期。
