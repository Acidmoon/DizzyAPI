/**
 * 字体注册表。
 *
 * 只保留三个**随包自带**的字体（`geist` 包里的本地字体文件），不依赖
 * `next/font/google`：静态导出的构建期不该联网下载字体，产物也不必因此变大。
 * 每个条目的 `key` 必须与 `globals.css` 里的 `html[data-font="<key>"]` 规则一一对应。
 */
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";

export const fontRegistry = {
  geist: {
    label: "Geist",
    font: GeistSans,
  },
  geistMono: {
    label: "Geist Mono",
    font: GeistMono,
  },
  geistPixelSquare: {
    label: "Geist Pixel Square",
    font: GeistPixelSquare,
  },
} as const;

export type FontKey = keyof typeof fontRegistry;

export const fontKeys = Object.keys(fontRegistry) as FontKey[];

export const fontVars = Object.values(fontRegistry)
  .map(({ font }) => font.variable)
  .join(" ");

export const fontOptions = fontKeys.map((key) => ({
  key,
  label: fontRegistry[key].label,
}));
