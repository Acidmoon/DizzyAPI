"use client";

/**
 * 价格表 `/user/pricing`：**只读**（owner 明确要求「价格表也要只读展示出来」）。
 *
 * 这里**不许有任何写入口**：没有「新增 / 编辑 / 删除」按钮，没有提交表单，不发 PUT/DELETE。
 * 改价格是管理员在管理台做的事（`/dashboard/pricing`）。护栏用例见
 * `packages/dashboard/test/user-pricing-readonly.test.ts`。
 *
 * 单价口径：**每百万 token 多少元**，服务端给十进制字符串，本页只展示、不换算、不四舍五入成浮点。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

import { fetchPricing, messageOfError, redirectToLogin } from "../_lib/api";
import type { ModelPrice } from "../_lib/types";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../_components/page-states";

/** 价格字段可能是字符串（正常）或数字（旧数据）；展示一律按原文，不做数值换算。 */
function priceText(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

export default function UserPricingPage() {
  const [items, setItems] = useState<readonly ModelPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchPricing());
    } catch (caught) {
      if ((caught as { unauthenticated?: boolean }).unauthenticated === true) {
        redirectToLogin();
        return;
      }
      setError(messageOfError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (needle === "") return items;
    return items.filter((item) => item.model.toLowerCase().includes(needle));
  }, [items, keyword]);

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">价格表</h1>
          <p className="text-sm text-muted-foreground">
            单价单位：元 / 百万 token。本页只读，需要调整价格请联系管理员。
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索模型名…"
            aria-label="搜索模型"
            className="w-56 pl-8"
          />
        </div>
      </div>

      {error === null ? null : <ErrorBlock message={error} onRetry={() => void load()} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>模型单价</CardTitle>
          <CardDescription>
            {loading ? "正在读取价格表…" : `共 ${items.length} 个已定价模型${keyword === "" ? "" : `，匹配 ${filtered.length} 个`}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock rows={6} label="正在加载价格表…" />
          ) : filtered.length === 0 ? (
            <EmptyBlock
              title={items.length === 0 ? "管理员还没有配置任何模型价格" : "没有匹配的模型"}
              description={items.length === 0 ? "价格由管理员在管理台维护，配置后这里会出现" : "换个关键词试试"}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead className="text-right">输入</TableHead>
                  <TableHead className="text-right">输出</TableHead>
                  <TableHead className="text-right">缓存读取</TableHead>
                  <TableHead className="text-right">缓存写入</TableHead>
                  <TableHead>更新于</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => (
                  <TableRow key={item.model}>
                    <TableCell className="max-w-64 truncate font-medium" title={item.model}>
                      {item.model}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{priceText(item.inputPerMillion)}</TableCell>
                    <TableCell className="text-right tabular-nums">{priceText(item.outputPerMillion)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {priceText(item.cacheReadPerMillion)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {priceText(item.cacheWritePerMillion)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(item.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">只读</Badge>
        <span>计价币种：人民币（CNY）</span>
        <span>·</span>
        <span>未在此表出现的模型不可请求（管理员未定价）</span>
      </div>
    </div>
  );
}
