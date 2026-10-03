import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import {
  AlertStatusBadge, CategoryBadge, HealthBar, MachineStatus, ReportStatusBadge, SeverityIcon, timeAgo,
} from "@/components/shared";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  Activity, AlertTriangle, Boxes, CheckCircle2, CloudSun, Cpu, Gauge, GitBranch,
  HardHat, ListChecks, MapPin, RefreshCw, Users, Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Data = {
  user: Doc<"users"> | null;
  sites: Doc<"sites">[];
  machines: Doc<"machines">[];
  events: Doc<"events">[];
  alerts: Doc<"alerts">[];
  tasks: Doc<"actionItems">[];
  reports: Doc<"engineerReports">[];
};

const EVENT_ICON: Record<string, typeof Activity> = {
  telemetry: Gauge,
  maintenance: Wrench,
  environment: CloudSun,
  interaction: HardHat,
  alert: AlertTriangle,
  fix: CheckCircle2,
  update: Boxes,
};

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: typeof Activity; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="border-border/70 shadow-soft">
      <CardContent className="flex items-center gap-3 p-4">
        <span className={`flex size-10 items-center justify-center rounded-lg ${tone ?? "bg-primary/15 text-foreground"}`}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-xl font-bold leading-none">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{label}{sub ? ` · ${sub}` : ""}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ManagerView({ user, data }: { user: Doc<"users"> | null; data: Data }) {
  const ingest = useMutation(api.app.ingestBatch);
  const ack = useMutation(api.app.acknowledgeAlert);
  const resolve = useMutation(api.app.resolveAlert);
  const complete = useMutation(api.app.completeTask);
  const graph = useQuery(api.app.knowledgeGraph);
  const [syncing, setSyncing] = useState(false);

  const activeAlerts = data.alerts.filter((a) => a.status !== "resolved");
  const criticalAlerts = activeAlerts.filter((a) => a.severity === "critical");
  const openTasks = data.tasks.filter((t) => t.status === "open");
  const running = data.machines.filter((m) => m.status === "operational").length;
  const openCases = data.reports.filter((r) => r.status !== "resolved");
  const sortedAlerts = [...activeAlerts].sort(
    (a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1) || b.createdAt - a.createdAt,
  );
  const sortedCases = [...data.reports].sort(
    (a, b) => (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0) || b.updatedAt - a.updatedAt,
  );

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await ingest({});
      toast.success("Job-site data synced into memory", { description: res.notes.join(" · ") });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Welcome back, {user?.name?.split(" ")[0] ?? "manager"}</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">Operations overview</h1>
        </div>
        <Button onClick={() => void sync()} disabled={syncing} className="gap-2 shadow-soft">
          <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing job site…" : "Sync data feed"}
        </Button>
      </div>

      {/* Sites */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {data.sites.map((s) => {
          const fleet = data.machines.filter((m) => m.siteId === s._id);
          const runningN = fleet.filter((m) => m.status === "operational").length;
          return (
            <Card key={s._id} className="border-border/70 bg-gradient-to-br from-card to-secondary/60 shadow-soft">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-display font-semibold">{s.name}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="size-3" /> {s.location} · {s.phase}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium">
                    <span className={`size-1.5 rounded-full ${s.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`} />
                    {s.status === "active" ? "Active" : "Hold"}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><CloudSun className="size-3.5" />{s.weatherCondition}, {Math.round(s.weatherTempC)}°C, {s.windKph} kph</span>
                  <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{s.crewCount} crew</span>
                  <span className="inline-flex items-center gap-1"><Cpu className="size-3.5" />{runningN}/{fleet.length} machines running</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* KPIs */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Cpu} label="Machines running" value={`${running}/${data.machines.length}`} />
        <Kpi icon={AlertTriangle} label="Open alerts" value={String(activeAlerts.length)} sub={`${criticalAlerts.length} critical`} tone={criticalAlerts.length > 0 ? "bg-red-100 text-red-700" : undefined} />
        <Kpi icon={ListChecks} label="Open tasks" value={String(openTasks.length)} />
        <Kpi icon={Wrench} label="CAT engineering cases" value={String(openCases.length)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {/* Left: feed + machines + graph */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><Activity className="size-4 text-amber-500" /> Live from the job sites</CardTitle>
              <span className="text-xs text-muted-foreground">memory stream</span>
            </CardHeader>
            <CardContent className="max-h-96 space-y-1 overflow-y-auto pr-2">
              {data.events.slice(0, 20).map((e) => {
                const Icon = EVENT_ICON[e.kind] ?? Activity;
                return (
                  <div key={e._id} className="flex items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-accent/60">
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${e.severity === "critical" ? "bg-red-100 text-red-600" : e.severity === "warning" ? "bg-amber-100 text-amber-600" : "bg-secondary text-muted-foreground"}`}>
                      <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{e.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{e.detail}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(e.createdAt)}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><Cpu className="size-4 text-amber-500" /> CAT assets</CardTitle>
              <span className="text-xs text-muted-foreground">health from memory</span>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {data.machines.map((m) => (
                <div key={m._id} className="rounded-xl border border-border bg-background/50 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{m.name}</p>
                    <MachineStatus status={m.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{data.sites.find((s) => s._id === m.siteId)?.name} · {m.hours.toLocaleString()} hrs</p>
                  <div className="mt-2.5"><HealthBar value={m.health} /></div>
                  <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px] text-muted-foreground">
                    <span><span className="block font-semibold text-foreground">{Math.round(m.engineTempC)}°C</span>engine</span>
                    <span><span className="block font-semibold text-foreground">{Math.round(m.fuelPct)}%</span>fuel</span>
                    <span><span className="block font-semibold text-foreground">{Math.round(m.nextServiceHours)}h</span>to service</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><GitBranch className="size-4 text-amber-500" /> Knowledge graph</CardTitle>
              <span className="text-xs text-muted-foreground">ever-growing</span>
            </CardHeader>
            <CardContent>
              {graph && (
                <>
                  <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-secondary/70 py-2">
                      <p className="font-display text-lg font-bold leading-none">{graph.stats.events}</p>
                      <p className="text-[11px] text-muted-foreground">events remembered</p>
                    </div>
                    <div className="rounded-lg bg-secondary/70 py-2">
                      <p className="font-display text-lg font-bold leading-none">{graph.stats.connections}</p>
                      <p className="text-[11px] text-muted-foreground">connections learned</p>
                    </div>
                    <div className="rounded-lg bg-secondary/70 py-2">
                      <p className="font-display text-lg font-bold leading-none">{graph.stats.machines}</p>
                      <p className="text-[11px] text-muted-foreground">assets under memory</p>
                    </div>
                  </div>
                  <KnowledgeGraph nodes={graph.nodes} edges={graph.edges} />
                </>
              )}
            </CardContent>
          </Card>
        </div>
        {/* Right rail */}
        <div className="space-y-4">
          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><AlertTriangle className="size-4 text-red-500" /> Alerts</CardTitle>
              <span className="text-xs text-muted-foreground">{sortedAlerts.length} active</span>
            </CardHeader>
            <CardContent className="max-h-80 space-y-2.5 overflow-y-auto">
              {sortedAlerts.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing needs attention.</p>
              )}
              {sortedAlerts.slice(0, 8).map((a) => (
                <div key={a._id} className={`rounded-xl border p-3.5 ${a.severity === "critical" && a.status === "open" ? "border-red-200 bg-red-50/50" : "border-border"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug">{a.title}</p>
                    <SeverityIcon severity={a.severity} className="size-4 shrink-0" />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <CategoryBadge category={a.category} />
                    <AlertStatusBadge status={a.status} />
                    <span className="text-[11px] text-muted-foreground">{timeAgo(a.createdAt)}</span>
                  </div>
                  {a.status === "open" && (
                    <div className="mt-2.5 flex gap-2">
                      <Button size="sm" variant="outline" className="h-8 flex-1" onClick={() => void ack({ alertId: a._id })}>Acknowledge</Button>
                      <Button size="sm" variant="ghost" className="h-8 flex-1" onClick={() => void resolve({ alertId: a._id })}>Resolve</Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><ListChecks className="size-4 text-emerald-600" /> Action items</CardTitle>
              <span className="text-xs text-muted-foreground">{openTasks.length} open</span>
            </CardHeader>
            <CardContent className="max-h-72 space-y-2 overflow-y-auto">
              {openTasks.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">All clear.</p>}
              {openTasks.slice(0, 10).map((t) => (
                <button key={t._id} onClick={() => void complete({ taskId: t._id })} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-emerald-300 hover:bg-accent/50">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-stone-300" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-medium ${t.priority === "urgent" ? "text-red-700" : ""}`}>{t.title}</span>
                    <span className="block text-xs text-muted-foreground">{t.assignee}</span>
                  </span>
                  {t.priority === "urgent" && <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">URGENT</span>}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-soft">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="flex items-center gap-2 font-display text-base"><Wrench className="size-4 text-slate-600" /> CAT Engineering</CardTitle>
              <span className="text-xs text-muted-foreground">{openCases.length} open</span>
            </CardHeader>
            <CardContent className="max-h-72 space-y-2 overflow-y-auto">
              {sortedCases.slice(0, 8).map((r) => {
                const m = data.machines.find((x) => x._id === r.machineId);
                return (
                  <div key={r._id} className="rounded-lg border border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{r.title}</p>
                      <ReportStatusBadge status={r.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {m?.name ?? "Fleet"} · updated {timeAgo(r.updatedAt)}
                    </p>
                    {r.productUpdate && <p className="mt-1 text-xs text-emerald-700">Shipped: {r.productUpdate}</p>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
