"use client";

/**
 * 模型广场 `/user/models`：我们卖什么、多少钱、现在能不能用。
 *
 * 数据来自 `GET /api/models`（`modelhub` 的只读聚合：价格 + 账号声明的模型与协议）。
 * 页面**只读**：没有「新增 / 编辑」入口，改模型与价格是管理员在管理台的事。
 *
 * 单价口径：**元 / 百万 token** 的十进制字符串，只展示不换算（换算要看用量与单价相乘，
 * 那是计费的事，前端不做）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckCircle2, Search, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, errorMessage, pricing } from "@/lib/api";
import type { ModelCatalogView } from "@/lib/api";

import { MODEL_REASON_LABELS, statusLabel } from "../_lib/labels";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";

type Availability = "all" | "available" | "unavailable";
type Priced = "all" | "priced" | "unpriced";

/** 价格字段是十进制字符串；缺失显示「—」而不是 0（0 元是「免费」，不是「没定价」）。 */
function priceText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number" ? String(value) : value;
}

export default function UserModelsPage() {
  const [catalog, setCatalog] = useState<ModelCatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState<Availability>("all");
  const [priced, setPriced] = useState<Priced>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await pricing.fetchModels(api));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 筛选放在前端做：目录是全量返回的（几十条），每打一个字就发一次请求没必要。
  const visible = useMemo(() => {
    if (catalog === null) return { available: [], unavailable: [] };
    const needle = search.trim().toLowerCase();
    const match = (model: string): boolean => needle === "" || model.toLowerCase().includes(needle);
    return {
      available: availability === "unavailable" ? [] : catalog.available.filter((entry) => match(entry.model)),
      unavailable:
        availability === "available" ? [] : catalog.unavailable.filter((entry) => match(entry.model)),
    };
  }, [catalog, search, availability]);

  /** 「已定价 / 未定价」筛选对两个列表都生效。 */
  const keepByPrice = (entryPriced: boolean): boolean =>
    priced === "all" || (priced === "priced" ? entryPriced : !entryPriced);

  const available = visible.available.filter((entry) => keepByPrice(entry.priced));
  const unavailable = visible.unavailable.filter((entry) => keepByPrice(entry.priced));

  return (
    <div className="@container/main flex min-w-0 flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">模型广场</h1>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      {catalog === null ? (
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="pt-6">
            <LoadingBlock rows={6} label="正在加载模型目录…" />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[
              { label: "可用模型", value: catalog.summary.availableCount },
              { label: "不可用", value: catalog.summary.unavailableCount },
              { label: "已定价", value: catalog.summary.pricedCount },
              { label: "参与统计的账号", value: catalog.summary.accountCount },
            ].map((card) => (
              <Card key={card.label} className="min-w-0 overflow-hidden">
                <CardHeader>
                  <CardDescription>{card.label}</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">{card.value}</CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索模型名…"
                aria-label="搜索模型"
                className="w-56 pl-8"
              />
            </div>
            <Select value={availability} onValueChange={(value) => setAvailability(value as Availability)}>
              <SelectTrigger size="sm" className="w-32" aria-label="可用性">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部可用性</SelectItem>
                <SelectItem value="available">只看可用</SelectItem>
                <SelectItem value="unavailable">只看不可用</SelectItem>
              </SelectContent>
            </Select>
            <Select value={priced} onValueChange={(value) => setPriced(value as Priced)}>
              <SelectTrigger size="sm" className="w-32" aria-label="定价">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部定价</SelectItem>
                <SelectItem value="priced">只看已定价</SelectItem>
                <SelectItem value="unpriced">只看未定价</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle>可用模型</CardTitle>
            </CardHeader>
            <CardContent>
              {available.length === 0 ? (
                <EmptyBlock title="没有符合条件的可用模型" description="换一个搜索词或筛选条件试试" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>模型</TableHead>
                      <TableHead className="text-right">输入 / 百万</TableHead>
                      <TableHead className="text-right">输出 / 百万</TableHead>
                      <TableHead className="text-right">缓存读</TableHead>
                      <TableHead className="text-right">缓存写</TableHead>
                      <TableHead>定价</TableHead>
                      <TableHead>健康 / 总账号</TableHead>
                      <TableHead>协议</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {available.map((entry) => (
                      <TableRow key={entry.model}>
                        <TableCell className="max-w-56 truncate font-medium" title={entry.model}>
                          {entry.model}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priceText(entry.price?.inputPerMillion)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priceText(entry.price?.outputPerMillion)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priceText(entry.price?.cacheReadPerMillion)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priceText(entry.price?.cacheWritePerMillion)}
                        </TableCell>
                        <TableCell>
                          {entry.priced ? <Badge>已定价</Badge> : <Badge variant="outline">未定价</Badge>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {entry.healthyAccountCount} / {entry.accountCount}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.protocols.length === 0 ? "未声明" : entry.protocols.join(" / ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <XCircle className="size-4" />
                暂不可用
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unavailable.length === 0 ? (
                <EmptyBlock title="没有被判定为不可用的模型" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>模型</TableHead>
                      <TableHead className="text-right">输入 / 百万</TableHead>
                      <TableHead>原因</TableHead>
                      <TableHead>说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unavailable.map((entry) => (
                      <TableRow key={entry.model}>
                        <TableCell className="max-w-56 truncate font-medium" title={entry.model}>
                          {entry.model}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {priceText(entry.price?.inputPerMillion)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="destructive">{statusLabel(MODEL_REASON_LABELS, entry.reason)}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{entry.detail}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            「未定价」的模型仍可调用，但费用按 0 计算，直到管理员在管理台配上价格。
          </p>
        </>
      )}
    </div>
  );
}
