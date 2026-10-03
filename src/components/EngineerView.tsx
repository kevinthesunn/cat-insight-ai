import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { REPORT_STATUS_META, SeverityIcon, timeAgo } from "@/components/shared";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import {
  Activity, CheckCircle2, ChevronRight, Cpu, Lightbulb, MapPin, PackageCheck, Search, Wrench,
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

export default function EngineerView({ data }: { data: Data }) {
  const saveNotes = useMutation(api.app.saveInvestigation);
  const quickFix = useMutation(api.app.provideQuickFix);
  const shipUpdate = useMutation(api.app.resolveInUpdate);

  const [notes, setNotes] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<{ mode: "quickfix" | "update"; report: Doc<"engineerReports"> } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const active = data.reports
    .filter((r) => r.status === "new" || r.status === "investigating")
    .sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1) || b.createdAt - a.createdAt);
  const fixing = data.reports.filter((r) => r.status === "quick_fix");
  const shipped = data.reports.filter((r) => r.status === "resolved").sort((a, b) => b.updatedAt - a.updatedAt);

  const machineEvents = (machineId?: string) =>
    machineId ? data.events.filter((e) => e.machineId === machineId).slice(0, 6) : [];

  const openDialog = (mode: "quickfix" | "update", report: Doc<"engineerReports">) => {
    setDraft(mode === "quickfix" ? report.quickFix ?? "" : report.productUpdate ?? "");
    setDialog({ mode, report });
  };

  const submitDialog = async () => {
    if (!dialog || !draft.trim()) return;
    setBusy(true);
    try {
      if (dialog.mode === "quickfix") {
        await quickFix({ reportId: dialog.report._id, quickFix: draft.trim() });
        toast.success("Quick fix sent to the site crew");
      } else {
        await shipUpdate({ reportId: dialog.report._id, productUpdate: draft.trim() });
        toast.success("Marked as fixed in the next product update");
      }
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  const CaseCard = ({ report }: { report: Doc<"engineerReports"> }) => {
    const machine = data.machines.find((m) => m._id === report.machineId);
    const site = data.sites.find((s) => s._id === report.siteId);
    const memory = machineEvents(report.machineId);
    return (
      <Card className="border-border/70 shadow-soft">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${report.severity === "critical" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>
                <Wrench className="size-5" />
              </span>
              <div>
                <CardTitle className="font-display text-base leading-snug">{report.title}</CardTitle>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Cpu className="size-3" />{machine?.name ?? "Fleet"}</span>
                  <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{site?.name}</span>
                  <span>reported {timeAgo(report.createdAt)}</span>
                </p>
              </div>
            </div>
            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${REPORT_STATUS_META[report.status]?.cls ?? ""}`}>
              {REPORT_STATUS_META[report.status]?.label}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <p className="rounded-lg bg-secondary/70 p-3 text-sm leading-relaxed text-foreground/90">{report.symptom}</p>

          {memory.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Activity className="size-3.5" /> Machine memory
              </p>
              <div className="space-y-1">
                {memory.map((e) => (
                  <div key={e._id} className="flex items-start gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-xs">
                    <SeverityIcon severity={e.severity} className="mt-0.5 size-3 shrink-0" />
                    <span className="min-w-0 flex-1"><span className="font-medium">{e.title}</span> — <span className="text-muted-foreground">{e.detail}</span></span>
                    <span className="shrink-0 text-muted-foreground">{timeAgo(e.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.investigation && (
            <p className="whitespace-pre-line rounded-lg border border-sky-200 bg-sky-50/60 p-3 text-sm text-sky-950">
              <span className="font-semibold">Investigation so far: </span>{report.investigation}
            </p>
          )}
          {report.quickFix && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-950">
              <span className="inline-flex items-center gap-1 font-semibold"><Lightbulb className="size-3.5" /> Quick fix with the crew: </span>{report.quickFix}
            </p>
          )}

          {report.status === "new" || report.status === "investigating" ? (
            <div className="space-y-2.5">
              <Textarea
                value={notes[report._id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [report._id]: e.target.value }))}
                placeholder={report.status === "new" ? "Start the investigation — what does the memory say?" : "Add investigation notes…"}
                className="min-h-20"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={!(notes[report._id] ?? "").trim()}
                  onClick={() => {
                    void saveNotes({ reportId: report._id, notes: (notes[report._id] ?? "").trim() });
                    setNotes((n) => ({ ...n, [report._id]: "" }));
                    toast.success("Investigation notes saved to memory");
                  }}
                >
                  <Search className="size-3.5" /> {report.status === "new" ? "Start investigating" : "Save notes"}
                </Button>
                <Button size="sm" className="gap-1.5 bg-primary" onClick={() => openDialog("quickfix", report)}>
                  <Lightbulb className="size-3.5" /> Send quick fix to crew
                </Button>
                <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => openDialog("update", report)}>
                  <PackageCheck className="size-3.5" /> Fixed in product update
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openDialog("update", report)}>
                <PackageCheck className="size-3.5" /> Resolve in product update
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-8 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Caterpillar Engineering</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">Machine issue queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">Problems the memory layer escalated from the field. Crews are waiting on quick fixes.</p>
        </div>
        <span className="flex size-11 items-center justify-center rounded-xl bg-stone-900 text-white shadow-soft"><Wrench className="size-5" /></span>
      </div>

      <section className="mt-7 space-y-4">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          Needs investigation
          {active.length > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">{active.length}</span>}
        </h2>
        {active.length === 0 && (
          <Card className="border-border/70 shadow-soft"><CardContent className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-5 text-emerald-500" /> Queue is clear. The memory layer is watching every asset.
          </CardContent></Card>
        )}
        {active.map((r) => <CaseCard key={r._id} report={r} />)}
      </section>

      {fixing.length > 0 && (
        <section className="mt-8 space-y-4">
          <h2 className="font-display text-base font-semibold">Quick fixes with the crew</h2>
          {fixing.map((r) => <CaseCard key={r._id} report={r} />)}
        </section>
      )}

      {shipped.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-base font-semibold">Solved long-term in product updates</h2>
          <div className="mt-3 space-y-2">
            {shipped.map((r) => (
              <Card key={r._id} className="border-border/70 shadow-soft">
                <CardContent className="flex items-center gap-3 p-4">
                  <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.productUpdate}</p>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      <Dialog open={!!dialog} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">
              {dialog?.mode === "quickfix" ? "Send a quick fix to the crew" : "Resolve in a product update"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === "quickfix"
                ? "Simple words. The crew applies this on site today, and it becomes part of the machine's memory."
                : "Describe the engineering change so this never happens again. It closes the loop."}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-28" placeholder={dialog?.mode === "quickfix" ? "e.g. Swap the water separator filter (P/N 1R-0750) — 20-minute job." : "e.g. Revised hydraulic cooling curve shipping in firmware 2.4."} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button disabled={busy || !draft.trim()} onClick={() => void submitDialog()}>
              {dialog?.mode === "quickfix" ? "Send to crew" : "Close the loop"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
