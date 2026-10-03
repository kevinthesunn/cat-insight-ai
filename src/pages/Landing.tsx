import { Button } from "@/components/ui/button";
import { Brand } from "@/pages/Dashboard";
import { motion } from "framer-motion";
import {
  AlertTriangle, ArrowRight, CloudSun, Gauge, GitBranch, HardHat, Lightbulb,
  PackageCheck, ShieldAlert, Users, Wrench,
} from "lucide-react";
import { Link } from "react-router";

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.55 },
};

const STEPS = [
  { icon: Gauge, title: "Ingest", desc: "Telemetry, service logs, weather and crew notes stream in from every asset and site." },
  { icon: GitBranch, title: "Learn", desc: "The memory engine processes it all into a knowledge graph that grows by the hour." },
  { icon: AlertTriangle, title: "Alert", desc: "When a problem surfaces, the people on that site are alerted with clear action items." },
  { icon: Wrench, title: "Resolve", desc: "Mechanical issues go straight to CAT engineers — quick fixes back to the crew, real fixes into product updates." },
];

const MEMORY_INPUTS = [
  { icon: Gauge, title: "Operational history", desc: "Every hour, load cycle and temperature curve each machine has ever seen." },
  { icon: Wrench, title: "Maintenance events", desc: "Services, failures and fixes — remembered across the whole fleet." },
  { icon: CloudSun, title: "Environmental conditions", desc: "Weather, ground and site conditions tied to what machines experienced." },
  { icon: HardHat, title: "User interactions", desc: "Operator notes and crew reports, captured without slowing anyone down." },
];

const ROLES = [
  { icon: HardHat, title: "For the crew", desc: "One big button to report a problem. Alerts in plain words. Tap-to-finish tasks. Nothing else.", tag: "Built for gloves, not manuals" },
  { icon: Users, title: "For site managers", desc: "A single dashboard showing everything going on — machines, alerts, tasks, engineer cases — across all sites.", tag: "The whole site at a glance" },
  { icon: ShieldAlert, title: "For CAT engineers", desc: "A live queue of machine issues with each machine's full memory attached. Send quick fixes; ship product updates.", tag: "Investigate with context" },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Brand />
          <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
            <a href="#how" className="transition hover:text-foreground">How it works</a>
            <a href="#memory" className="transition hover:text-foreground">Memory layer</a>
            <a href="#roles" className="transition hover:text-foreground">Who it's for</a>
          </nav>
          <Button asChild className="shadow-soft">
            <Link to="/auth">Open the console <ArrowRight className="size-4" /></Link>
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="bg-grid-faint absolute inset-0 [mask-image:radial-gradient(ellipse_60%_60%_at_50%_35%,black,transparent)]" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-2 lg:pt-24">
          <div>
            <motion.div {...fadeUp} className="inline-flex items-center gap-2 rounded-full border border-amber-300/70 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
              <span className="size-1.5 rounded-full bg-amber-500" />
              Intelligent memory layer for CAT assets & job sites
            </motion.div>
            <motion.h1 {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.08 }} className="mt-5 font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Every machine remembers.
              <br />
              <span className="text-stone-500">Every site learns.</span>
            </motion.h1>
            <motion.p {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.16 }} className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">
              CATerra turns your job-site data into an ever-growing knowledge graph — so problems get caught early, crews know exactly what to do, and CAT engineers close the loop for good.
            </motion.p>
            <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.24 }} className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-12 px-6 text-base shadow-lift">
                <Link to="/auth">Open the console <ArrowRight className="size-4" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-12 bg-card/70 px-6 text-base">
                <a href="#how">See how it works</a>
              </Button>
            </motion.div>
            <motion.p {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.3 }} className="mt-5 text-sm text-muted-foreground">
              Free to try · Works for crews, managers and CAT engineers
            </motion.p>
          </div>

          {/* Hero visual: layered console mock */}
          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.2 }} className="relative">
            <div className="rounded-2xl border border-border bg-card p-4 shadow-lift">
              <div className="flex items-center gap-1.5 pb-3">
                <span className="size-2.5 rounded-full bg-stone-300" />
                <span className="size-2.5 rounded-full bg-stone-300" />
                <span className="size-2.5 rounded-full bg-primary" />
                <span className="ml-2 text-xs font-medium text-muted-foreground">CATerra · Northgate Logistics Hub</span>
              </div>
              <div className="rounded-xl bg-secondary/70 p-3">
                <svg viewBox="0 0 420 200" className="w-full">
                  <line x1="210" y1="100" x2="80" y2="46" stroke="#D6D3D1" strokeWidth="1.5" />
                  <line x1="210" y1="100" x2="352" y2="52" stroke="#D6D3D1" strokeWidth="1.5" />
                  <line x1="210" y1="100" x2="64" y2="152" stroke="#D6D3D1" strokeWidth="1.5" />
                  <line x1="210" y1="100" x2="330" y2="158" stroke="#D6D3D1" strokeWidth="1.5" />
                  <line x1="210" y1="100" x2="210" y2="30" stroke="#F87171" strokeWidth="1.5" />
                  <line x1="210" y1="30" x2="322" y2="18" stroke="#D9A506" strokeWidth="1.5" strokeDasharray="4 3" />
                  <circle cx="210" cy="100" r="13" fill="#292524" />
                  <text x="210" y="128" textAnchor="middle" fontSize="11" fontWeight="600" fill="#292524">Northgate Hub</text>
                  <circle cx="80" cy="46" r="9" fill="#D9A506" />
                  <text x="80" y="68" textAnchor="middle" fontSize="10" fill="#57534E">D8T Dozer</text>
                  <circle cx="352" cy="52" r="9" fill="#D9A506" />
                  <text x="352" y="74" textAnchor="middle" fontSize="10" fill="#57534E">745 Truck</text>
                  <circle cx="64" cy="152" r="9" fill="#D9A506" />
                  <text x="64" y="174" textAnchor="middle" fontSize="10" fill="#57534E">950M Loader</text>
                  <circle cx="330" cy="158" r="9" fill="#D9A506" />
                  <text x="330" y="180" textAnchor="middle" fontSize="10" fill="#57534E">320 GC Exc</text>
                  <circle cx="210" cy="30" r="7" fill="#DC2626" />
                  <circle cx="210" cy="30" r="12" fill="none" stroke="#DC2626" strokeOpacity="0.4" />
                  <text x="210" y="12" textAnchor="middle" fontSize="10" fontWeight="600" fill="#DC2626">Overheat alert</text>
                  <circle cx="322" cy="18" r="6" fill="#10B981" />
                  <text x="322" y="6" textAnchor="middle" fontSize="9" fill="#059669">Quick fix</text>
                </svg>
              </div>
            </div>
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.7, duration: 0.5 }}
              className="absolute -right-3 top-10 hidden w-60 rounded-xl border border-red-200 bg-white p-3 shadow-lift sm:block"
            >
              <p className="flex items-center gap-1.5 text-xs font-bold text-red-600"><AlertTriangle className="size-3.5" /> CRITICAL · 7m ago</p>
              <p className="mt-1 text-sm font-semibold leading-snug">320 GC — hydraulic overheat</p>
              <p className="mt-0.5 text-xs text-muted-foreground">CAT engineers notified automatically.</p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.9, duration: 0.5 }}
              className="absolute -left-3 bottom-8 hidden w-60 rounded-xl border border-emerald-200 bg-white p-3 shadow-lift sm:block"
            >
              <p className="flex items-center gap-1.5 text-xs font-bold text-emerald-600"><PackageCheck className="size-3.5" /> QUICK FIX · CAT Engineering</p>
              <p className="mt-1 text-sm font-semibold leading-snug">Swap water separator (P/N 1R-0750)</p>
              <p className="mt-0.5 text-xs text-muted-foreground">20-minute job · sent to the crew</p>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Stats band */}
      <section className="border-y border-border bg-secondary/50">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-6 px-4 py-10 text-center sm:px-6 md:grid-cols-4">
          {[
            ["4.2M+", "operational events remembered"],
            ["2,300+", "CAT assets under memory"],
            ["38%", "fewer repeat failures"],
            ["< 1 min", "from detection to crew alert"],
          ].map(([v, l]) => (
            <div key={l}>
              <p className="font-display text-3xl font-bold tracking-tight">{v}</p>
              <p className="mt-1 text-sm text-muted-foreground">{l}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Data goes in. Problems come out — solved.</h2>
          <p className="mt-3 text-muted-foreground">One loop, running continuously across every asset and every site.</p>
        </motion.div>
        <div className="mt-12 grid gap-4 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <motion.div key={s.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.08 }} className="relative rounded-2xl border border-border bg-card p-6 shadow-soft transition hover:-translate-y-1 hover:shadow-lift">
              <span className="absolute right-5 top-5 font-display text-4xl font-bold text-stone-100">{i + 1}</span>
              <span className="flex size-11 items-center justify-center rounded-xl bg-primary/15">
                <s.icon className="size-5" />
              </span>
              <h3 className="mt-4 font-display text-lg font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Memory inputs */}
      <section id="memory" className="border-y border-border bg-secondary/40">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <motion.div {...fadeUp} className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-widest text-amber-600">The memory layer</p>
            <h2 className="mt-2 font-display text-3xl font-bold tracking-tight sm:text-4xl">Four streams in. One brain out.</h2>
            <p className="mt-3 text-muted-foreground">CATerra never forgets what a machine has been through — and connects it to what's happening right now.</p>
          </motion.div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MEMORY_INPUTS.map((m, i) => (
              <motion.div key={m.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.06 }} className="rounded-2xl border border-border bg-card p-6 shadow-soft">
                <m.icon className="size-6 text-amber-500" />
                <h3 className="mt-3 font-semibold">{m.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Roles */}
      <section id="roles" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Simple for everyone it serves</h2>
          <p className="mt-3 text-muted-foreground">Especially the people on the ground. CATerra shows each person exactly what they need — and nothing they don't.</p>
        </motion.div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {ROLES.map((r, i) => (
            <motion.div key={r.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.08 }} className="flex flex-col rounded-2xl border border-border bg-card p-7 shadow-soft transition hover:-translate-y-1 hover:shadow-lift">
              <span className="flex size-12 items-center justify-center rounded-xl bg-stone-900 text-primary">
                <r.icon className="size-6" />
              </span>
              <span className="mt-4 inline-flex w-fit rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">{r.tag}</span>
              <h3 className="mt-2 font-display text-xl font-semibold">{r.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-20 sm:px-6">
        <motion.div {...fadeUp} className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-stone-900 px-6 py-16 text-center shadow-lift sm:px-12">
          <div className="bg-grid-faint absolute inset-0 opacity-40" />
          <div className="relative">
            <Lightbulb className="mx-auto size-8 text-primary" />
            <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">Put a memory behind your job sites.</h2>
            <p className="mx-auto mt-3 max-w-xl text-stone-400">Crews stay safe and moving. Managers see everything. CAT engineers fix it for good.</p>
            <Button asChild size="lg" className="mt-8 h-12 px-8 text-base shadow-lift">
              <Link to="/auth">Open the console <ArrowRight className="size-4" /></Link>
            </Button>
          </div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <Brand />
          <p>Intelligent memory layer for Caterpillar assets and job sites.</p>
        </div>
      </footer>
    </div>
  );
}
