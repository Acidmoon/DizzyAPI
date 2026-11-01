"use client";

/**
 * 新建密钥的弹窗（只有「名称」一个字段）。
 *
 * 改名已经收进 `KeyEditDialog`（名称 / 启用 / 过期时间 / 金额上限 / 并发上限一起改），
 * 所以这里只管创建，不再有 rename 分支——两条路径并存只会让「改名字」有两个入口、两份校验。
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface KeyNameDialogProps {
  readonly open: boolean;
  readonly initialName?: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => void;
}

export function KeyNameDialog({
  open,
  initialName = "",
  pending,
  error,
  onOpenChange,
  onSubmit,
}: KeyNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setTouched(false);
    }
  }, [open, initialName]);

  const trimmed = name.trim();
  const invalid = trimmed === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 API 密钥</DialogTitle>
          <DialogDescription>名称只用于你自己分辨用途，例如「本地调试」「线上服务」。</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (invalid) return;
            onSubmit(trimmed);
          }}
        >
          <Field data-invalid={touched && invalid ? true : undefined}>
            <FieldLabel htmlFor="key-name">名称</FieldLabel>
            <Input
              id="key-name"
              value={name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="例如：本地调试…"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && invalid ? true : undefined}
            />
            <FieldDescription>最多 64 个字符</FieldDescription>
            {touched && invalid ? <FieldError>名称不能为空</FieldError> : null}
          </Field>

          {error === null ? null : <FieldError>{error}</FieldError>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "提交中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
