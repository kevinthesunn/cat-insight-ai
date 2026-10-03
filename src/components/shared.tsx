import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Info, Wrench, ShieldAlert, CloudSun, Gauge } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function timeAgo(ts: number) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const severityStyles: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  info: "bg-stone-500/10 text-stone-700 dark:text-stone-300 border-stone-500/30",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium capitalize", severityStyles[severity] ?? severityStyles.info)}>
      {severity}
    </Badge>
  );
}

export const CATEGORY_ICON: Record<string, LucideIcon> = {
  mechanical: Wrench,
  safety: ShieldAlert,
  environmental: CloudSun,
  operational: Gauge,
};

const categoryStyles: Record<string, string> = {
  mechanical: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  safety: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  environmental: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  operational: "bg-stone-500/10 text-stone-700 dark:text-stone-300 border-stone-500/30",
};

export function CategoryBadge({ category }: { category: string }) {
  const Icon = CATEGORY_ICON[category] ?? Info;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium capitalize", categoryStyles[category] ?? categoryStyles.operational)}>
      <Icon className="size-3" />
      {category}
    </Badge>
  );
}

const alertStatusStyles: Record<string, { cls: string; label: string }> = {
  open: { cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30", label: "Needs attention" },
  acknowledged: { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30", label: "Crew on it" },
  resolved: { cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", label: "Resolved" },
};

export function AlertStatusBadge({ status }: { status: string }) {
  const s = alertStatusStyles[status] ?? alertStatusStyles.open;
  return (
    <Badge variant="outline" className={cn("font-medium", s.cls)}>
      {s.label}
    </Badge>
  );
}

const machineStatusStyles: Record<string, { cls: string; dot: string; label: string }> = {
  operational: { cls: "text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500", label: "Running" },
  idle: { cls: "text-amber-700 dark:text-amber-400", dot: "bg-amber-500", label: "Idle" },
  maintenance: { cls: "text-sky-700 dark:text-sky-400", dot: "bg-sky-500", label: "In service" },
  down: { cls: "text-red-700 dark:text-red-400", dot: "bg-red-500", label: "Down" },
};

export function MachineStatus({ status }: { status: string }) {
  const s = machineStatusStyles[status] ?? machineStatusStyles.idle;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.cls)}>
      <span className={cn("size-2 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export const REPORT_STATUS_META: Record<string, { cls: string; label: string }> = {
  new: { cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30", label: "New — needs investigation" },
  investigating: { cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30", label: "Investigating" },
  quick_fix: { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30", label: "Quick fix with crew" },
  resolved: { cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", label: "Fixed in product update" },
};

export function ReportStatusBadge({ status }: { status: string }) {
  const s = REPORT_STATUS_META[status] ?? REPORT_STATUS_META.new;
  return (
    <Badge variant="outline" className={cn("font-medium", s.cls)}>
      {s.label}
    </Badge>
  );
}

export function HealthBar({ value }: { value: number }) {
  const tone = value >= 85 ? "bg-emerald-500" : value >= 70 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-200">
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="text-xs font-medium text-muted-foreground">{Math.round(value)}%</span>
    </div>
  );
}

export function SeverityIcon({ severity, className }: { severity: string; className?: string }) {
  if (severity === "critical")
    return <AlertTriangle className={cn("text-red-600", className)} />;
  if (severity === "warning")
    return <AlertTriangle className={cn("text-amber-500", className)} />;
  return <CheckCircle2 className={cn("text-emerald-600", className)} />;
}
