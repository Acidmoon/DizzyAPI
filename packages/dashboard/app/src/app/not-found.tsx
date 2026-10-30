"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-2xl font-semibold">页面不存在</h1>
      <p className="text-muted-foreground">你访问的地址没有对应的页面，可能是链接过期了。</p>
      <Button asChild variant="outline">
        <Link prefetch={false} replace href="/dashboard">
          回到控制台
        </Link>
      </Button>
    </main>
  );
}
