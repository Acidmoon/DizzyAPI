import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "仪表盘 · DizzyAPI 控制台",
};

export default function Page() {
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">仪表盘</h1>
        <p className="text-muted-foreground text-sm">
          站点总览。指标区、趋势图与最近动作用来聚合用量链路、结算与账号池的状态。
        </p>
      </div>
      <section
        aria-labelledby="dashboard-placeholder"
        className="bg-card text-card-foreground flex flex-col gap-2 rounded-xl border p-6"
      >
        <h2 id="dashboard-placeholder" className="text-base font-semibold">
          页面建设中
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          外壳（侧栏、顶栏、主题与布局偏好）已就位；本页与其余业务页在后续批次里接入 `/api/*` 数据。
        </p>
      </section>
    </div>
  );
}
