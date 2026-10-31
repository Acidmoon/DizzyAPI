"use client";

/**
 * API 文档 `/user/docs`：把仓库里的 `docs/api/*.md` 渲染成可读文档。
 *
 * 两条口径：
 *
 * 1. **不引 markdown 库**：文档只用到标题 / 段落 / 列表 / 围栏代码 / 表格 / 行内代码这几种子集，
 *    自己写一个**返回块模型**的解析器（`_lib/markdown.ts`），页面用 React 组件渲染 ——
 *    **不经过 `dangerouslySetInnerHTML`**，所以文档里出现 HTML 也不会变成注入面。
 * 2. **内容来自静态资源**：构建时 `docs/api/*.md` 被复制到 `app/public/docs/`，
 *    导出后由插件按普通静态文件发出；页面 `fetch('/docs/xx.md')` 取原文。
 *    这条复制由 `test/user-docs-source.test.ts` 守着（逐字比对，防止文档改了前端不跟）。
 *
 * 已知缺口（**明确显示，不装作没有**）：文档里 `<!-- facts:xxx -->` 这几处表格，旧 SSR 页
 * 是渲染时从 Go / TS 源码实时派生的；新前端是静态导出，构建期不读源码，所以这里只能明说
 * 「这张表这一版没有生成」，而不是渲染一张手抄的、会腐烂的表。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { BookOpen, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { parseInline, parseMarkdown, type Block, type InlineNode } from "../_lib/markdown";
import { ErrorBlock, LoadingBlock } from "../_components/page-states";

/** 文档清单（与 `docs/api/` 下的文件名一一对应；顺序即阅读顺序）。 */
const DOCS = [
  { slug: "01-overview", title: "总览与认证" },
  { slug: "02-endpoints", title: "入口一览" },
  { slug: "03-errors", title: "错误体与错误码" },
  { slug: "04-examples", title: "调用示例" },
  { slug: "05-limits-billing", title: "限流与计费" },
] as const;

type DocSlug = (typeof DOCS)[number]["slug"];

/** 行内节点 → React（**不用 innerHTML**）。 */
function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "strong") {
          return (
            <strong key={index} className="font-semibold">
              {node.text}
            </strong>
          );
        }
        if (node.kind === "code") {
          return (
            <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {node.text}
            </code>
          );
        }
        if (node.kind === "link") {
          // 文档里的链接都是站内路径或仓库说明；新窗口打开避免丢掉当前阅读位置。
          return (
            <a
              key={index}
              href={node.href}
              className="underline underline-offset-4"
              {...(node.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {node.text}
            </a>
          );
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      const size =
        block.level === 1 ? "text-xl" : block.level === 2 ? "text-lg" : "text-base";
      return (
        <Tag className={`font-heading ${size} mt-6 font-semibold tracking-tight first:mt-0`}>
          <Inline nodes={block.inlines} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="text-sm leading-relaxed text-foreground/90">
          <Inline nodes={block.inlines} />
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`flex flex-col gap-1 pl-5 text-sm leading-relaxed ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, index) => (
            <li key={index}>
              <Inline nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <div className="flex flex-col gap-1">
          {block.language === "" ? null : (
            <span className="text-xs text-muted-foreground">{block.language}</span>
          )}
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed">
            <code className="font-mono">{block.code}</code>
          </pre>
        </div>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
          <Inline nodes={block.inlines} />
        </blockquote>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                    {parsePlain(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-2 py-1.5 align-top">
                      {parsePlain(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "divider":
      return <hr className="border-border" />;
    case "facts":
      return (
        <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 p-3 text-xs leading-relaxed">
          <p className="font-medium">这张表这一版没有生成（`{block.id}`）</p>
          <p className="mt-1 text-muted-foreground">
            旧版文档页是在渲染时从 Go / TS 源码实时派生这张表（入口表 / 错误码表），所以永远不会过期。
            新版前端是静态导出，构建期不读源码，因此这里**不做手抄**——手抄必腐烂。
            要恢复这张表需要一条构建期派生步骤，已作为缺口上报。
          </p>
        </div>
      );
    default:
      return null;
  }
}

/** 表格单元格里的行内标记（粗体 / 代码）渲染成纯文本即可（表格里放组件会撑破列宽）。 */
function parsePlain(text: string): string {
  return parseInline(text)
    .map((node) => node.text)
    .join("");
}

function DocumentBody({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

export default function UserDocsPage() {
  const [slug, setSlug] = useState<DocSlug>("01-overview");
  const [sources, setSources] = useState<Partial<Record<DocSlug, string>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const entries = await Promise.all(
          DOCS.map(async (doc) => {
            const response = await fetch(`/docs/${doc.slug}.md`);
            if (!response.ok) throw new Error(`取手文档失败：${doc.slug}（HTTP ${response.status}）`);
            return [doc.slug, await response.text()] as const;
          }),
        );
        if (!alive) return;
        setSources(Object.fromEntries(entries) as Partial<Record<DocSlug, string>>);
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : "文档加载失败");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const copyCurrent = useCallback(async () => {
    const source = sources[slug];
    if (source === undefined) return;
    try {
      await navigator.clipboard.writeText(source);
      toast.success("已复制本篇 Markdown");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  }, [sources, slug]);

  const body = sources[slug];

  return (
    <div className="@container/main flex min-w-0 flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading flex items-center gap-2 text-xl font-semibold tracking-tight">
            <BookOpen className="size-5" />
            API 文档
          </h1>
          <p className="text-sm text-muted-foreground">
            内容取自仓库 `docs/api/*.md`；复制出来就是 Markdown 原文，可以直接投喂给 agent。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void copyCurrent()} disabled={body === undefined}>
          <Copy className="size-3.5" />
          复制本篇 Markdown
        </Button>
      </div>

      {error === null ? null : <ErrorBlock message={error} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>DizzyAPI 接入手册</CardTitle>
          <CardDescription>
            四种客户端协议（OpenAI Chat / Responses / Anthropic / Gemini）共用一套 API key
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock rows={8} label="正在加载文档…" />
          ) : (
            <Tabs value={slug} onValueChange={(value) => setSlug(value as DocSlug)}>
              <TabsList className="mb-4 flex w-full flex-wrap justify-start">
                {DOCS.map((doc) => (
                  <TabsTrigger key={doc.slug} value={doc.slug}>
                    {doc.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              {DOCS.map((doc) => {
                const source = sources[doc.slug];
                return (
                  <TabsContent key={doc.slug} value={doc.slug} className="min-w-0">
                    {source === undefined ? null : <DocumentBody source={source} />}
                  </TabsContent>
                );
              })}
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
