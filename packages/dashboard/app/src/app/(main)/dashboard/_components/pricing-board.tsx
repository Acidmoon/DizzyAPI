"use client";

/**
 * 模型价格（`/dashboard/pricing`）：读全站价表 + 新增 / 改价 / 删除（**管理员写**）。
 *
 * 接口：
 * - `GET /api/pricing` → `{ items: ModelPriceView[] }`（任何登录用户可读）
 * - `PUT /api/pricing/:model` → 写价（管理员，服务端记审计）
 * - `DELETE /api/pricing/:model` → 删价（管理员）
 *
 * 三条纪律：
 * - 单价是**每百万 token 的元字符串**，页面只做格式化与透传，**不做算术**（不做浮点）。
 * - 模型名可能含 `/`，URL 里必须 `encodeURIComponent`（endpoint 层已处理）。
 * - 没配价的模型**不会被请求**（定价闸门打开时 403 `MODEL_NOT_PRICED`），所以「缺价」要在页面上直说。
 */
import { useCallback, useState } from "react";

import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, pricing, type ModelPriceView } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { DataState } from "./data-state";
import { PriceDialog } from "./pricing-dialog";
import { useResource } from "./use-resource";

export function PricingBoard() {
  const [editing, setEditing] = useState<ModelPriceView | "new" | null>(null);
  const [removing, setRemoving] = useState<ModelPriceView | null>(null);

  const load = useCallback(() => pricing.fetchPricing(api), []);
  const { data, error, loading, reload } = useResource(load);
  const items = data?.items ?? [];

  async function removePrice(price: ModelPriceView): Promise<void> {
    try {
      await pricing.deleteModelPrice(api, price.model);
      toast.success(`已删除 ${price.model} 的价格`);
      setRemoving(null);
      reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "删除失败");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">模型价格</h1>
                  </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
          <Button onClick={() => setEditing("new")}>
            <Plus /> 添加模型
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">价表</CardTitle>
          <CardDescription>共 {items.length} 个模型。</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <DataState
            loading={loading}
            error={error}
            empty={items.length === 0}
            onRetry={reload}
            emptyTitle="价表是空的"
            emptyDescription="没有配价的模型在闸门打开后无法被请求。点右上角「添加模型」开始。"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">模型</TableHead>
                    <TableHead className="text-right">输入 / 百万</TableHead>
                    <TableHead className="text-right">输出 / 百万</TableHead>
                    <TableHead className="text-right">缓存读 / 百万</TableHead>
                    <TableHead className="text-right">缓存写 / 百万</TableHead>
                    <TableHead>更新于</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((price) => (
                    <TableRow key={price.model}>
                      <TableCell className="pl-4">
                        <span className="font-mono text-xs">{price.model}</span>
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          {price.currency}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{price.inputPerMillion}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{price.outputPerMillion}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {price.cacheReadPerMillion}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {price.cacheWritePerMillion}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(price.updatedAt)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(price)}>
                            <Pencil /> 编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setRemoving(price)}
                          >
                            <Trash2 /> 删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <PriceDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />

      {removing === null ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base">删除「{removing.model}」的价格？</CardTitle>
              <CardDescription>
                删除后这个模型会被当成未定价：闸门打开时请求会被 403 拒绝。历史用量按读取时算价，金额也会跟着变。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => void removePrice(removing)}>
                确认删除
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
