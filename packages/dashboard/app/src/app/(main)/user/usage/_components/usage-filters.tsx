"use client";

/**
 * 明细页的筛选条：时间范围 / 模型 / API 密钥 + 导出。
 *
 * 三个筛选值都是页面本地 state（不做 URL 同步）：静态导出下用 `useSearchParams`
 * 需要额外包一层 `Suspense`，而筛选属于「当场操作」，刷新后回到默认值更符合预期。
 */

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { RANGE_LABELS } from "../../_lib/api";
import type { ApiKeySummary, UsageModelRow, UsageRange } from "../../_lib/types";

const ALL = "__all__";

export interface UsageFiltersProps {
  readonly range: UsageRange;
  readonly model: string | null;
  readonly apiKeyId: string | null;
  readonly models: readonly UsageModelRow[];
  readonly keys: readonly ApiKeySummary[];
  readonly exporting: boolean;
  readonly onRangeChange: (range: UsageRange) => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onApiKeyChange: (apiKeyId: string | null) => void;
  readonly onExport: () => void;
}

export function UsageFilters({
  range,
  model,
  apiKeyId,
  models,
  keys,
  exporting,
  onRangeChange,
  onModelChange,
  onApiKeyChange,
  onExport,
}: UsageFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={range} onValueChange={(value) => onRangeChange(value as UsageRange)}>
        <SelectTrigger size="sm" className="w-32" aria-label="时间范围">
          <SelectValue placeholder={RANGE_LABELS[range]} />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(RANGE_LABELS) as UsageRange[]).map((key) => (
            <SelectItem key={key} value={key}>
              {RANGE_LABELS[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={model ?? ALL} onValueChange={(value) => onModelChange(value === ALL ? null : value)}>
        <SelectTrigger size="sm" className="w-44" aria-label="模型">
          <SelectValue placeholder="全部模型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部模型</SelectItem>
          {models.map((row) => (
            <SelectItem key={row.model} value={row.model}>
              {row.model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={apiKeyId ?? ALL} onValueChange={(value) => onApiKeyChange(value === ALL ? null : value)}>
        <SelectTrigger size="sm" className="w-44" aria-label="API 密钥">
          <SelectValue placeholder="全部密钥" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部密钥</SelectItem>
          {keys.map((key) => (
            <SelectItem key={key.id} value={key.id}>
              {key.name === "" ? key.maskedKey : key.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button size="sm" variant="outline" onClick={onExport} disabled={exporting}>
        <Download className="size-3.5" />
        {exporting ? "导出中…" : "导出 CSV"}
      </Button>
    </div>
  );
}
