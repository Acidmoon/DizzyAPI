import Link from "next/link";

import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { APP_CONFIG } from "@/config/app-config";

export const metadata: Metadata = {
  title: APP_CONFIG.meta.title,
  description: APP_CONFIG.meta.description,
  alternates: {
    canonical: "/",
  },
};

const FEATURES = [
  {
    title: "统一入口",
    body: "一套 OpenAI 兼容的入口，同时支持 /v1/chat/completions、/v1/responses、/v1/messages 与 Gemini 原生协议。",
  },
  {
    title: "账号池调度",
    body: "按优先级、权重、并发与健康状态挑选上游账号，429 与额度耗尽自动冷却换号。",
  },
  {
    title: "真实扣费",
    body: "按用量四桶与价格表复算整数微元，逐条结算；余额与流水可追溯，不做事件驱动计费。",
  },
] as const;

export default function Home() {
  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-12 sm:px-6 sm:py-16">
        <header className="flex flex-col gap-4">
          <span className="text-muted-foreground text-sm font-medium tracking-wide">{APP_CONFIG.name}</span>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            自托管的模型网关控制台
          </h1>
          <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{APP_CONFIG.meta.description}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link prefetch={false} href="/auth/v2/login">
                登录控制台
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link prefetch={false} href="/auth/v2/register">
                注册账号
              </Link>
            </Button>
          </div>
        </header>

        <section aria-labelledby="landing-features" className="flex flex-col gap-4">
          <h2 id="landing-features" className="text-lg font-semibold">
            能做什么
          </h2>
          <ul className="grid gap-4 sm:grid-cols-3">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="bg-card text-card-foreground rounded-xl border p-4">
                <h3 className="text-sm font-semibold">{feature.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <footer className="text-muted-foreground border-t pt-6 text-sm">{APP_CONFIG.copyright}</footer>
      </div>
    </main>
  );
}
