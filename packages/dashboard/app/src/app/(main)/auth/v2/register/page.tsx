import Link from "next/link";

import type { Metadata } from "next";

import { APP_CONFIG } from "@/config/app-config";

import { RegisterForm } from "../../_components/register-form";

export const metadata: Metadata = {
  title: "注册 · DizzyAPI 控制台",
  description: "注册 DizzyAPI 账号，创建 API 密钥并开始调用模型。",
  alternates: {
    canonical: "/auth/v2/register",
  },
};

export default function RegisterV2() {
  return (
    <>
      <div className="mx-auto flex w-full flex-col justify-center space-y-8 sm:w-[350px]">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-medium">创建账号</h1>
          <p className="text-muted-foreground text-sm">请输入邮箱与密码。</p>
        </div>
        <div className="space-y-4">
          <RegisterForm />
        </div>
      </div>

      <div className="absolute top-5 flex w-full justify-end px-10">
        <div className="text-muted-foreground text-sm">
          已经有账号？{" "}
          <Link prefetch={false} className="text-foreground" href="login">
            登录
          </Link>
        </div>
      </div>

      <div className="absolute bottom-5 flex w-full justify-between px-10">
        <div className="text-sm">{APP_CONFIG.copyright}</div>
      </div>
    </>
  );
}
