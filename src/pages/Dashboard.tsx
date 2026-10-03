import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { HardHat, LogOut, Wrench, UserCog, Users, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import WorkerView from "@/components/WorkerView";
import ManagerView from "@/components/ManagerView";
import EngineerView from "@/components/EngineerView";

export const ROLE_META: Record<string, { label: string; cls: string }> = {
  worker: { label: "Site crew", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  manager: { label: "Site manager", cls: "bg-sky-100 text-sky-900 border-sky-200" },
  engineer: { label: "CAT engineer", cls: "bg-stone-200 text-stone-800 border-stone-300" },
};

function RolePicker({ onPick }: { onPick: (role: string) => void }) {
  const roles = [
    { id: "worker", icon: HardHat, title: "I work on site", desc: "Big buttons. Alerts and tasks for my crew." },
    { id: "manager", icon: Users, title: "I run the site", desc: "The full dashboard — everything going on." },
    { id: "engineer", icon: Wrench, title: "I'm CAT engineering", desc: "Investigate machine issues, send quick fixes." },
  ];
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-8 text-center">
          <Brand />
          <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">How do you use the job site?</h1>
          <p className="mt-1 text-sm text-muted-foreground">CATerra shapes itself around your day. You can switch later.</p>
        </div>
        <div className="grid gap-3">
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => onPick(r.id)}
              className="group flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lift"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-foreground">
                <r.icon className="size-6" />
              </span>
              <span className="flex-1">
                <span className="block font-semibold">{r.title}</span>
                <span className="block text-sm text-muted-foreground">{r.desc}</span>
              </span>
              <Repeat className="size-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary shadow-soft">
        <HardHat className="size-5 text-primary-foreground" />
      </span>
      <span className={`font-display text-lg font-bold tracking-tight ${light ? "text-white" : "text-foreground"}`}>
        CATerra
      </span>
    </span>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const data = useQuery(api.app.overview);
  const seed = useMutation(api.app.seedIfEmpty);
  const pickRole = useMutation(api.app.pickRole);
  const seeded = useRef(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (data && data.sites.length === 0 && !seeded.current) {
      seeded.current = true;
      void seed();
    }
  }, [data, seed]);

  if (!data || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-pulse text-sm text-muted-foreground">Warming up the memory layer…</div>
      </main>
    );
  }

  const role = user.role && ROLE_META[user.role] ? user.role : null;
  if (!role) {
    return (
      <RolePicker
        onPick={(r) => {
          void pickRole({ role: r });
          toast.success("Welcome aboard.");
        }}
      />
    );
  }

  const mySite = data.sites.find((s) => s._id === user.siteId);
  const shared = { user, data, role };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Brand />
          <span className="hidden text-sm text-muted-foreground sm:block">
            {mySite ? mySite.name : role === "engineer" ? "All job sites" : "All job sites"}
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
                const next = role === "worker" ? "manager" : role === "manager" ? "engineer" : "worker";
                void pickRole({ role: next }).finally(() => {
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
      {role === "worker" ? <WorkerView {...shared} /> : role === "engineer" ? <EngineerView {...shared} /> : <ManagerView {...shared} />}
    </div>
  );
}
