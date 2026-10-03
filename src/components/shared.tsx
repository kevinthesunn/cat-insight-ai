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
  critical: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-amber-100 text-amber-900 border-amber-200",
  info: "bg-stone-100 text-stone-700 border-stone-200",
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
  mechanical: "bg-amber-100 text-amber-900 border-amber-200",
  safety: "bg-red-100 text-red-800 border-red-200",
  environmental: "bg-sky-100 text-sky-900 border-sky-200",
  operational: "bg-stone-100 text-stone-700 border-stone-200",
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
  open: { cls: "bg-red-50 text-red-700 border-red-200", label: "Needs attention" },
  acknowledged: { cls: "bg-amber-50 text-amber-800 border-amber-200", label: "Crew on it" },
  resolved: { cls: "bg-emerald-50 text-emerald-800 border-emerald-200", label: "Resolved" },
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
  operational: { cls: "text-emerald-700", dot: "bg-emerald-500", label: "Running" },
  idle: { cls: "text-amber-700", dot: "bg-amber-500", label: "Idle" },
  maintenance: { cls: "text-sky-700", dot: "bg-sky-500", label: "In service" },
  down: { cls: "text-red-700", dot: "bg-red-500", label: "Down" },
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
  new: { cls: "bg-red-50 text-red-700 border-red-200", label: "New — needs investigation" },
  investigating: { cls: "bg-sky-50 text-sky-800 border-sky-200", label: "Investigating" },
  quick_fix: { cls: "bg-amber-50 text-amber-800 border-amber-200", label: "Quick fix with crew" },
  resolved: { cls: "bg-emerald-50 text-emerald-800 border-emerald-200", label: "Fixed in product update" },
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
