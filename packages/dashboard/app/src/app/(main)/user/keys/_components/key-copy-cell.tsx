"use client";

/**
 * 密钥那一格：显示**掩码**，点一下复制**完整 key**。
 *
 * 五条纪律：
 * 1. 显示文本永远是 `maskedKey` —— 完整 key **不进 DOM 文本**，只经剪贴板 API 出去
 *    （也不进 localStorage / sessionStorage / URL / console）。
 * 2. 复制的是 `secret`，不是 `maskedKey`：复制掩码等于给用户一个用不了的 key。
 * 3. `secret === null`（服务端没下发完整 key 的受限视图）→ 按钮**禁用并说明原因**，
 *    绝不复制空串。
 * 4. 复制失败要**明确提示**（非 HTTPS / 浏览器拒绝授权都会走到这里），不静默吞掉。
 * 5. 键盘可达：它本身是 `<button>`，Enter / Space 天然触发；焦点环走全站 `:focus-visible`。
 */

import { useEffect, useState } from "react";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { keyCopyTargetOf } from "./key-edit-logic";

/** 复制到剪贴板。**不落 DOM、不落 storage**，失败把原因抛给调用方。 */
async function writeClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    throw new Error("当前环境没有剪贴板接口（需要 HTTPS 或 localhost）");
  }
  await clipboard.writeText(text);
}

export function KeyCopyCell({ maskedKey, secret }: { readonly maskedKey: string; readonly secret: string | null }) {
  const target = keyCopyTargetOf({ maskedKey, secret });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    if (!target.copyable) return;
    try {
      await writeClipboard(target.secret);
      setCopied(true);
      toast.success("已复制完整密钥");
    } catch (caught) {
      const hint = caught instanceof Error ? caught.message : "浏览器拒绝了剪贴板访问";
      toast.error(`复制失败：${hint}。可用「轮换」拿到新密钥后手动复制。`);
    }
  };

  if (!target.copyable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* 禁用的按钮不派发指针事件，Tooltip 要挂在外层 span 上才弹得出来。 */}
          <span tabIndex={0} className="font-mono text-xs text-muted-foreground">
            <Button type="button" variant="ghost" size="sm" disabled className="font-mono text-xs">
              {target.label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{target.reason}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      className="font-mono text-xs"
      aria-label={`复制密钥 ${maskedKey} 的完整值`}
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {target.label}
    </Button>
  );
}
