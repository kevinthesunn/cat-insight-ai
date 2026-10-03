import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { HardHat, LogOut, UserCog, Users, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import CrewApp from "@/components/CrewApp";
import EngineerDashboard from "@/components/EngineerDashboard";

export const ROLE_META: Record<string, { label: string; cls: string }> = {
  operator: { label: "Operator", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  technician: { label: "Technician", cls: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  manager: { label: "Site manager", cls: "bg-sky-100 text-sky-900 border-sky-200" },
  engineer: { label: "CAT engineer", cls: "bg-stone-200 text-stone-800 border-stone-300" },
  admin: { label: "Admin", cls: "bg-stone-200 text-stone-800 border-stone-300" },
};

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-lg bg-stone-900 shadow-soft">
        <Wrench className="size-5 text-amber-400" />
      </span>
      <span className={`font-display text-lg font-bold tracking-tight ${light ? "text-white" : "text-foreground"}`}>
        SiteMemory
      </span>
    </span>
  );
}

const PICKER_ROLES = [
  { id: "operator", icon: HardHat, title: "I operate machines", desc: "Voice-first. Report a problem, get the fix that worked." },
  { id: "technician", icon: Wrench, title: "I'm a technician", desc: "Log repairs and confirm what worked on this machine." },
  { id: "manager", icon: Users, title: "I run a site", desc: "Open issues across my site, with evidence." },
  { id: "engineer", icon: Wrench, title: "I'm CAT engineering", desc: "Cross-site patterns, evidence, and the status workflow." },
] as const;

function RolePicker({ onPick }: { onPick: (role: string) => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="flex justify-center"><Brand /></div>
          <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">How do you work?</h1>
          <p className="mt-1 text-sm text-muted-foreground">SiteMemory shapes itself around your day. You can switch later.</p>
        </div>
        <div className="grid gap-3">
          {PICKER_ROLES.map((r) => (
            <button
              key={r.id}
              onClick={() => onPick(r.id)}
              className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:border-amber-400/60 hover:shadow-lift"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-900">
                <r.icon className="size-6" />
              </span>
              <span className="flex-1">
                <span className="block font-semibold">{r.title}</span>
                <span className="block text-sm text-muted-foreground">{r.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const seed = useMutation(api.seed.seedSiteMemory);
  const setRole = useMutation(api.ops.setRole);
  const boot = useQuery(api.store.crewBootstrap);
  const seeded = useRef(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!boot || seeded.current) return;
    if (boot.machines.length === 0) {
      seeded.current = true;
      void seed();
    }
  }, [boot, seed]);

  if (!user || !boot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-pulse text-sm text-muted-foreground">Loading the memory layer…</div>
      </main>
    );
  }

  const role = user.role && ROLE_META[user.role] ? user.role : null;
  if (!role) {
    return (
      <RolePicker
        onPick={(r) => {
          void setRole({ role: r as never });
          toast.success("Welcome aboard.");
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Brand />
          <span className="hidden text-sm text-muted-foreground sm:block">
            {boot.site ? boot.site.name : "All sites"}
          </span>
          <span className={`ml-auto hidden rounded-full border px-2.5 py-1 text-xs font-medium sm:inline-block ${ROLE_META[role].cls}`}>
            {ROLE_META[role].label}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              disabled={switching}
              onClick={() => {
                setSwitching(true);
                const order = ["operator", "technician", "manager", "engineer"];
                const next = order[(order.indexOf(role) + 1) % order.length];
                void setRole({ role: next as never }).finally(() => {
                  setSwitching(false);
                  toast.info(`Viewing as ${ROLE_META[next].label}`);
                });
              }}
            >
              <UserCog className="size-4" />
              <span className="hidden sm:inline">Switch view</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={async () => {
                await signOut();
                navigate("/");
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      {role === "operator" || role === "technician" ? (
        <CrewApp role={role} />
      ) : (
        <EngineerDashboard role={role} />
      )}
    </div>
  );
}
