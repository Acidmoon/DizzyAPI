import Link from "next/link";

import type { Metadata } from "next";

import { APP_CONFIG } from "@/config/app-config";

import { LoginForm } from "../../_components/login-form";

export const metadata: Metadata = {
  title: "登录 · DizzyAPI 控制台",
  description: "登录 DizzyAPI 控制台，管理上游账号、模型价格与用量。",
  alternates: {
    canonical: "/auth/v2/login",
  },
};

export default function LoginV2() {
  return (
    <>
      <div className="mx-auto flex w-full flex-col justify-center space-y-8 sm:w-[350px]">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-medium">登录账号</h1>
        </div>
        <div className="space-y-4">
          <LoginForm />
        </div>
      </div>

      <div className="absolute top-5 flex w-full justify-end px-10">
        <div className="text-muted-foreground text-sm">
          还没有账号？{" "}
          <Link prefetch={false} className="text-foreground" href="register">
            注册
          </Link>
        </div>
      </div>

      <div className="absolute bottom-5 flex w-full justify-between px-10">
        <div className="text-sm">{APP_CONFIG.copyright}</div>
      </div>
    </>
  );
}
