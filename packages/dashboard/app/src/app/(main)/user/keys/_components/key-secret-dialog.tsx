"use client";

/**
 * 一次性明文展示：新建 / 轮换 API 密钥后**只显示这一次**（服务端此后不再返回明文）。
 *
 * 三条纪律（owner 的硬要求）：
 * 1. 明文只进 React 内存 → 关掉弹窗即清空（`onClose` 里由父组件 `setSecret(null)`）；
 * 2. **不进 URL**（不写 query、不写 hash）、**不进 localStorage / sessionStorage**；
 * 3. **不进 console**（本文件不 console.log 任何东西）。
 */

import { useEffect, useState } from "react";

import { Copy, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface KeySecretDialogProps {
  /** `null` = 不显示（父组件在关闭时负责清空，明文不留在 state 里更久）。 */
  readonly secret: { readonly name: string; readonly secret: string } | null;
  readonly onClose: () => void;
}

export function KeySecretDialog({ secret, onClose }: KeySecretDialogProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [secret]);

  const copy = async () => {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret.secret);
      setCopied(true);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  };

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>请立即保存这把密钥</DialogTitle>
          <DialogDescription>
            「{secret?.name ?? ""}」的完整密钥只显示这一次，关闭后无法再次查看（只能轮换）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>
            密钥等同于账号密码：不要贴进聊天工具、不要提交到仓库、不要写进前端配置。只放在服务端环境变量里。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            {secret?.secret ?? ""}
          </code>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy className="size-3.5" />
            {copied ? "已复制" : "复制"}
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
