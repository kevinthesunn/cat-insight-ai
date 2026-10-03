import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---- helpers ----
const HOUR = 3_600_000;
const now = () => Date.now();
const ago = (hours: number) => Date.now() - hours * HOUR;

async function requireUser(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Sign in required");
  return await ctx.db.get(userId);
}

// ---- queries ----

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    const sites = await ctx.db.query("sites").collect();
    const machines = await ctx.db.query("machines").collect();
    const events = await ctx.db
      .query("events")
      .withIndex("by_created")
      .order("desc")
      .take(80);
    const alerts = await ctx.db.query("alerts").collect();
    const tasks = await ctx.db.query("actionItems").collect();
    const reports = await ctx.db.query("engineerReports").collect();
    return { user, sites, machines, events, alerts, tasks, reports };
  },
});

export const knowledgeGraph = query({
  args: {},
  handler: async (ctx) => {
    const [sites, machines, events, alerts, tasks, reports] = await Promise.all([
      ctx.db.query("sites").collect(),
      ctx.db.query("machines").collect(),
      ctx.db.query("events").withIndex("by_created").order("desc").take(60),
      ctx.db.query("alerts").collect(),
      ctx.db.query("actionItems").collect(),
      ctx.db.query("engineerReports").collect(),
    ]);
    const totalEvents = (await ctx.db.query("events").collect()).length;

    type Node = {
      id: string;
      kind: string;
      label: string;
      sub?: string;
      severity?: string;
    };
    type Edge = { from: string; to: string; label?: string; kind?: string };
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    for (const s of sites)
      nodes.push({ id: `site:${s._id}`, kind: "site", label: s.name, sub: s.phase });
    for (const m of machines) {
      nodes.push({
        id: `machine:${m._id}`,
        kind: "machine",
        label: m.name,
        sub: `${m.hours.toLocaleString()} hrs`,
      });
      edges.push({ from: `site:${m.siteId}`, to: `machine:${m._id}`, kind: "fleet" });
    }
    for (const a of alerts) {
      if (a.status === "resolved") continue;
      nodes.push({
        id: `alert:${a._id}`,
        kind: "alert",
        label: a.title,
        severity: a.severity,
      });
      edges.push({
        from: a.machineId ? `machine:${a.machineId}` : `site:${a.siteId}`,
        to: `alert:${a._id}`,
        kind: "raised",
      });
    }
    for (const e of events.slice(0, 12)) {
      nodes.push({
        id: `event:${e._id}`,
        kind: "event",
        label: e.title,
        sub: e.actor,
        severity: e.severity,
      });
      edges.push({
        from: e.machineId ? `machine:${e.machineId}` : `site:${e.siteId}`,
        to: `event:${e._id}`,
        kind: "memory",
      });
    }
    for (const r of reports) {
      nodes.push({
        id: `report:${r._id}`,
        kind: "report",
        label: r.title,
        sub: r.status === "resolved" ? "Shipped in update" : "CAT engineering",
      });
      edges.push({ from: `alert:${r.alertId}`, to: `report:${r._id}`, kind: "escalated" });
      if (r.machineId)
        edges.push({ from: `report:${r._id}`, to: `machine:${r.machineId}`, kind: "targets" });
      if (r.quickFix)
        nodes.push({
          id: `fix:${r._id}`,
          kind: "fix",
          label: "Quick fix",
          sub: r.quickFix.slice(0, 48) + "…",
        });
      if (r.quickFix) edges.push({ from: `report:${r._id}`, to: `fix:${r._id}`, kind: "fix" });
    }

    // pattern insight: repeated mechanical issues on the same asset
    const mechCount = new Map<string, number>();
    for (const a of alerts)
      if (a.category === "mechanical" && a.machineId)
        mechCount.set(a.machineId, (mechCount.get(a.machineId) ?? 0) + 1);
    for (const [machineId, count] of mechCount)
      if (count >= 2) {
        const m = machines.find((x) => x._id === machineId);
        nodes.push({
          id: `pattern:${machineId}`,
          kind: "pattern",
          label: "Repeat failure pattern",
          sub: `${count} mechanical events on ${m?.name ?? "asset"}`,
        });
        edges.push({ from: `machine:${machineId}`, to: `pattern:${machineId}`, kind: "pattern" });
      }

    return {
      nodes,
      edges,
      stats: {
        events: totalEvents,
        connections: edges.length,
        machines: machines.length,
        sites: sites.length,
        openAlerts: alerts.filter((a) => a.status !== "resolved").length,
        tasks: tasks.filter((t) => t.status === "open").length,
      },
    };
  },
});

export const seedIfEmpty = mutation({
  args: {},
  handler: async (ctx) => {
    if ((await ctx.db.query("sites").collect()).length > 0) return;

    const northgate = await ctx.db.insert("sites", {
      name: "Northgate Logistics Hub",
      location: "Building 4 pad, north lot",
      phase: "Earthworks",
      status: "active",
      weatherCondition: "Clear",
      weatherTempC: 24,
      windKph: 14,
      crewCount: 34,
      createdAt: ago(30 * 24),
    });
    const i90 = await ctx.db.insert("sites", {
      name: "I-90 Bridge Expansion",
      location: "East span staging",
      phase: "Structural",
      status: "active",
      weatherCondition: "High wind",
      weatherTempC: 18,
      windKph: 41,
      crewCount: 22,
      createdAt: ago(90 * 24),
    });

    const m1 = await ctx.db.insert("machines", {
      siteId: northgate,
      name: "D8T Dozer",
      model: "D8T",
      kind: "Dozer",
      serial: "CAT-D8T-44129",
      status: "operational",
      health: 92,
      hours: 8412,
      engineTempC: 91,
      fuelPct: 64,
      nextServiceHours: 132,
      createdAt: ago(30 * 24),
    });
    const m2 = await ctx.db.insert("machines", {
      siteId: northgate,
      name: "320 GC Excavator",
      model: "320 GC",
      kind: "Excavator",
      serial: "CAT-320GC-99031",
      status: "operational",
      health: 71,
      hours: 12980,
      engineTempC: 104,
      fuelPct: 41,
      nextServiceHours: 58,
      createdAt: ago(30 * 24),
    });
    const m3 = await ctx.db.insert("machines", {
      siteId: northgate,
      name: "950M Wheel Loader",
      model: "950M",
      kind: "Loader",
      serial: "CAT-950M-21007",
      status: "idle",
      health: 88,
      hours: 6204,
      engineTempC: 84,
      fuelPct: 78,
      nextServiceHours: 310,
      createdAt: ago(30 * 24),
    });
    await ctx.db.insert("machines", {
      siteId: northgate,
      name: "745 Articulated Truck",
      model: "745",
      kind: "Haul Truck",
      serial: "CAT-745-11883",
      status: "operational",
      health: 95,
      hours: 3477,
      engineTempC: 88,
      fuelPct: 57,
      nextServiceHours: 421,
      createdAt: ago(30 * 24),
    });
    await ctx.db.insert("machines", {
      siteId: i90,
      name: "14M3 Motor Grader",
      model: "14M3",
      kind: "Grader",
      serial: "CAT-14M3-70256",
      status: "operational",
      health: 90,
      hours: 5103,
      engineTempC: 89,
      fuelPct: 62,
      nextServiceHours: 76,
      createdAt: ago(90 * 24),
    });
    const m6 = await ctx.db.insert("machines", {
      siteId: i90,
      name: "D6 XE Dozer",
      model: "D6 XE",
      kind: "Dozer",
      serial: "CAT-D6XE-33418",
      status: "maintenance",
      health: 84,
      hours: 2891,
      engineTempC: 78,
      fuelPct: 22,
      nextServiceHours: 12,
      createdAt: ago(90 * 24),
    });

    // memory history — operational, maintenance, environment, interaction
    const ev = (
      hours: number,
      siteId: any,
      machineId: any,
      kind: string,
      title: string,
      detail: string,
      severity: string,
      actor: string,
    ) => ctx.db.insert("events", { siteId, machineId: machineId || undefined, kind, title, detail, severity, actor, createdAt: ago(hours) });

    await ev(70, northgate, m1, "maintenance", "500-hr service completed", "Oil, filters and final drive check signed off. Machine returned to service.", "info", "M. Ruiz, Mechanic");
    await ev(64, northgate, m1, "telemetry", "Stable operating temps", "Engine 88-92°C across shift. No anomalies.", "info", "Telemetry feed");
    await ev(52, northgate, m2, "telemetry", "Hydraulic oil temp climbing", "Peaked at 98°C under load cycle B.", "warning", "Telemetry feed");
    await ev(38, northgate, m2, "telemetry", "Hydraulic oil temp climbing again", "104°C sustained 12 min during bulk excavation.", "critical", "Telemetry feed");
    await ev(36, northgate, m2, "interaction", "Operator shift note", "Left track feels slightly loose on tight turns. Fine otherwise.", "info", "J. Alvarez, Operator");
    await ev(30, northgate, m3, "telemetry", "Fuel pressure code 4E-12", "Intermittent low fuel pressure at idle.", "warning", "Telemetry feed");
    await ev(29, i90, m6, "maintenance", "Approaching 500-hr service", "12 engine hours remaining on service interval.", "warning", "Service planner");
    await ev(26, northgate, m3, "fix", "Quick fix from CAT Engineering", "Water separator filter (P/N 1R-0750) was the cause. 20-minute swap cleared code 4E-12.", "info", "CAT Engineering");
    await ev(18, northgate, null, "environment", "Rain forecast overnight", "11 mm expected 6pm-midnight. Plan haul road drainage.", "info", "Weather feed");
    await ev(8, i90, null, "environment", "High wind advisory", "Gusts to 48 kph through the afternoon.", "warning", "Weather feed");
    await ev(7, northgate, m2, "telemetry", "Hydraulic oil temp critical", "108°C sustained — derate active. Excavator moved to light duty.", "critical", "Telemetry feed");
    await ev(5, northgate, null, "interaction", "Crew check-in", "Morning huddle complete. Crew of 34 on the pad.", "info", "T. Okafor, Foreman");

    const a1 = await ctx.db.insert("alerts", {
      siteId: northgate,
      machineId: m2,
      category: "mechanical",
      title: "320 GC Excavator — hydraulic overheat",
      message: "Hydraulic oil hit 108°C. Machine is derated. Switch to light duty until the CAT engineers come back.",
      severity: "critical",
      status: "open",
      source: "sensor",
      createdAt: ago(7),
    });
    await ctx.db.insert("alerts", {
      siteId: i90,
      machineId: undefined,
      category: "safety",
      title: "High wind — crane lifts paused",
      message: "Gusts to 48 kph. All crane lifts are paused until winds drop below 35 kph.",
      severity: "warning",
      status: "acknowledged",
      source: "weather",
      createdAt: ago(8),
      acknowledgedAt: ago(7.5),
    });
    const a3 = await ctx.db.insert("alerts", {
      siteId: i90,
      machineId: m6,
      category: "operational",
      title: "D6 XE due for 500-hr service",
      message: "12 engine hours left on the service interval. Book the mechanic now to avoid downtime.",
      severity: "warning",
      status: "open",
      source: "service",
      createdAt: ago(29),
    });
    const a4 = await ctx.db.insert("alerts", {
      siteId: northgate,
      machineId: m3,
      category: "mechanical",
      title: "950M Loader — fuel pressure code 4E-12",
      message: "Intermittent low fuel pressure at idle. CAT Engineering traced it to the water separator.",
      severity: "warning",
      status: "resolved",
      source: "sensor",
      createdAt: ago(30),
      resolvedAt: ago(26),
      resolution: "Quick fix applied — water separator filter swapped.",
    });

    await ctx.db.insert("engineerReports", {
      alertId: a1,
      siteId: northgate,
      machineId: m2,
      title: "320 GC — sustained hydraulic overheat under load",
      symptom: "Hydraulic oil temperature reaches 104-108°C during bulk excavation cycle B. Derate engages after ~12 min. Machine has 12,980 hrs. Two prior elevated-temp events in memory.",
      severity: "critical",
      status: "new",
      createdAt: ago(7),
      updatedAt: ago(7),
    });
    await ctx.db.insert("engineerReports", {
      alertId: a4,
      siteId: northgate,
      machineId: m3,
      title: "950M — intermittent low fuel pressure (code 4E-12)",
      symptom: "Low fuel pressure at idle, intermittent. No power loss logged. Fuel samples clean.",
      severity: "warning",
      status: "quick_fix",
      investigation: "Code 4E-12 correlates with partially clogged water separator on 950M units above 6,000 hrs. Three similar cases in fleet memory.",
      quickFix: "Replace water separator filter (P/N 1R-0750). 20-minute job — kit is in the site container. Clears the code immediately.",
      createdAt: ago(30),
      updatedAt: ago(26),
    });

    await ctx.db.insert("actionItems", {
      siteId: northgate,
      alertId: a1,
      title: "Switch 320 GC to light duty",
      detail: "Keep engine under 1,800 rpm until the overheat is figured out.",
      assignee: "All operators",
      priority: "urgent",
      status: "open",
      createdAt: ago(7),
    });
    await ctx.db.insert("actionItems", {
      siteId: i90,
      title: "Pause crane lifts",
      detail: "No lifts until gusts drop below 35 kph.",
      assignee: "Crane crew",
      priority: "urgent",
      status: "open",
      createdAt: ago(8),
    });
    await ctx.db.insert("actionItems", {
      siteId: i90,
      alertId: a3,
      title: "Book mechanic for D6 XE service",
      assignee: "T. Okafor",
      priority: "routine",
      status: "open",
      createdAt: ago(28),
    });
    await ctx.db.insert("actionItems", {
      siteId: northgate,
      title: "Top off haul road watering",
      assignee: "Ground crew",
      priority: "routine",
      status: "open",
      createdAt: ago(20),
    });
    await ctx.db.insert("actionItems", {
      siteId: northgate,
      alertId: a4,
      title: "Swap water separator on 950M",
      assignee: "M. Ruiz",
      priority: "routine",
      status: "done",
      createdAt: ago(26),
      completedAt: ago(25),
    });
  },
});

// ---- crew & manager actions ----

export const pickRole = mutation({
  args: { role: v.string() },
  handler: async (ctx, { role }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in required");
    const patch: Record<string, unknown> = { role };
    if (role === "worker") {
      const user = await ctx.db.get(userId);
      if (!user?.siteId) {
        const first = await ctx.db.query("sites").first();
        if (first) patch.siteId = first._id;
      }
    }
    await ctx.db.patch(userId, patch);
  },
});

export const reportProblem = mutation({
  args: {
    siteId: v.id("sites"),
    machineId: v.optional(v.id("machines")),
    category: v.string(),
    title: v.string(),
    detail: v.string(),
    severity: v.string(),
  },
  handler: async (ctx, { siteId, machineId, category, title, detail, severity }) => {
    const user = await requireUser(ctx);
    const alertId = await ctx.db.insert("alerts", {
      siteId,
      machineId,
      category,
      title,
      message: detail,
      severity,
      status: "open",
      source: "crew",
      createdAt: now(),
    });
    await ctx.db.insert("events", {
      siteId,
      machineId,
      kind: "alert",
      title,
      detail: detail || "Reported from the field.",
      severity,
      actor: user?.name || "Crew member",
      createdAt: now(),
    });
    if (category === "mechanical") {
      await ctx.db.insert("engineerReports", {
        alertId,
        siteId,
        machineId,
        title,
        symptom: detail,
        severity,
        status: "new",
        createdAt: now(),
        updatedAt: now(),
      });
    }
    return alertId;
  },
});

export const acknowledgeAlert = mutation({
  args: { alertId: v.id("alerts") },
  handler: async (ctx, { alertId }) => {
    const user = await requireUser(ctx);
    const alert = await ctx.db.get(alertId);
    if (!alert) throw new Error("Alert not found");
    await ctx.db.patch(alertId, { status: "acknowledged", acknowledgedAt: now() });
    await ctx.db.insert("events", {
      siteId: alert.siteId,
      machineId: alert.machineId,
      kind: "interaction",
      title: `Alert acknowledged: ${alert.title}`,
      detail: "Crew has seen it and is on it.",
      severity: "info",
      actor: user?.name || "Crew",
      createdAt: now(),
    });
  },
});

export const resolveAlert = mutation({
  args: { alertId: v.id("alerts"), resolution: v.optional(v.string()) },
  handler: async (ctx, { alertId, resolution }) => {
    const alert = await ctx.db.get(alertId);
    if (!alert) throw new Error("Alert not found");
    await ctx.db.patch(alertId, {
      status: "resolved",
      resolvedAt: now(),
      resolution: resolution || "Resolved on site.",
    });
    const open = await ctx.db
      .query("actionItems")
      .withIndex("by_alert", (q) => q.eq("alertId", alertId))
      .collect();
    for (const t of open)
      if (t.status === "open")
        await ctx.db.patch(t._id, { status: "done", completedAt: now() });
    await ctx.db.insert("events", {
      siteId: alert.siteId,
      machineId: alert.machineId,
      kind: "interaction",
      title: `Resolved: ${alert.title}`,
      detail: resolution || "Handled on site.",
      severity: "info",
      actor: "Site",
      createdAt: now(),
    });
  },
});

export const completeTask = mutation({
  args: { taskId: v.id("actionItems") },
  handler: async (ctx, { taskId }) => {
    const user = await requireUser(ctx);
    const task = await ctx.db.get(taskId);
    if (!task || task.status === "done") return;
    await ctx.db.patch(taskId, { status: "done", completedAt: now() });
    await ctx.db.insert("events", {
      siteId: task.siteId,
      machineId: undefined,
      kind: "interaction",
      title: `Task done: ${task.title}`,
      detail: task.detail ?? "Completed by the crew.",
      severity: "info",
      actor: user?.name || "Crew",
      createdAt: now(),
    });
    // when every task tied to an alert is done, the alert resolves itself
    if (task.alertId) {
      const siblings = await ctx.db
        .query("actionItems")
        .withIndex("by_alert", (q) => q.eq("alertId", task.alertId))
        .collect();
      if (siblings.length > 0 && siblings.every((t) => t.status === "done")) {
        const alert = await ctx.db.get(task.alertId);
        if (alert && alert.status !== "resolved") {
          await ctx.db.patch(task.alertId, {
            status: "resolved",
            resolvedAt: now(),
            resolution: "All action items completed.",
          });
          await ctx.db.insert("events", {
            siteId: alert.siteId,
            machineId: alert.machineId,
            kind: "interaction",
            title: `Resolved: ${alert.title}`,
            detail: "All action items completed.",
            severity: "info",
            actor: "Memory engine",
            createdAt: now(),
          });
        }
      }
    }
  },
});

export const addTask = mutation({
  args: {
    siteId: v.id("sites"),
    alertId: v.optional(v.id("alerts")),
    title: v.string(),
    assignee: v.string(),
    priority: v.string(),
  },
  handler: async (ctx, { siteId, alertId, title, assignee, priority }) => {
    await ctx.db.insert("actionItems", {
      siteId,
      alertId,
      title,
      assignee,
      priority,
      status: "open",
      createdAt: now(),
    });
  },
});

// ---- live data feed: ingest job-site data into the memory layer ----

export const ingestBatch = mutation({
  args: {},
  handler: async (ctx) => {
    const sites = await ctx.db.query("sites").collect();
    const machines = await ctx.db.query("machines").collect();
    if (sites.length === 0) return { notes: ["No sites to ingest for yet."] };
    const notes: string[] = [];
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const site = pick(sites);
    const siteMachines = machines.filter((m) => m.siteId === site._id);
    const machine = siteMachines.length ? pick(siteMachines) : undefined;
    const ts = now();
    const log = (
      kind: string, title: string, detail: string, severity: string, actor: string,
    ) =>
      ctx.db.insert("events", {
        siteId: site._id, machineId: machine?._id, kind, title, detail, severity, actor, createdAt: ts,
      });

    const roll = Math.random();
    if (roll < 0.3 && machine) {
      // mechanical anomaly -> alert -> CAT engineering
      const temp = 100 + Math.floor(Math.random() * 9);
      await ctx.db.patch(machine._id, { engineTempC: temp, health: Math.max(40, machine.health - 6), status: "idle" });
      await log("telemetry", `${machine.name} — operating temp ${temp}°C`, "Sustained over-temperature under load. Derate engaged.", "critical", "Telemetry feed");
      const alertId = await ctx.db.insert("alerts", {
        siteId: site._id, machineId: machine._id, category: "mechanical",
        title: `${machine.name} — overheat detected`,
        message: `Operating temp hit ${temp}°C. Machine is idled. CAT engineers have been notified automatically.`,
        severity: "critical", status: "open", source: "sensor", createdAt: ts,
      });
      await ctx.db.insert("engineerReports", {
        alertId, siteId: site._id, machineId: machine._id,
        title: `${machine.name} — overheat at ${temp}°C`,
        symptom: `Temperature climbed to ${temp}°C during normal load cycle. Prior memory: ${machine.hours.toLocaleString()} hrs on the clock.`,
        severity: "critical", status: "new", createdAt: ts, updatedAt: ts,
      });
      await ctx.db.insert("actionItems", {
        siteId: site._id, alertId,
        title: `Idle the ${machine.name}`, detail: "Let it cool down. Do not load it until engineers reply.",
        assignee: "Operator", priority: "urgent", status: "open", createdAt: ts,
      });
      notes.push(`Overheat on ${machine.name} — CAT Engineering alerted`);
    } else if (roll < 0.5) {
      // weather shift -> environmental alert + site prep tasks
      const windy = Math.random() < 0.5;
      await ctx.db.patch(site._id, windy
        ? { weatherCondition: "High wind", windKph: 40 + Math.floor(Math.random() * 15) }
        : { weatherCondition: "Rain", weatherTempC: site.weatherTempC - 6 });
      await log("environment", windy ? "Wind picking up" : "Rain moving in",
        windy ? `Gusts to ${site.windKph + 25} kph expected.` : "Steady rain for the next few hours.", "warning", "Weather feed");
      const alertId = await ctx.db.insert("alerts", {
        siteId: site._id, category: "environmental",
        title: windy ? "High wind on site" : "Rain on site",
        message: windy ? "Tie down loose materials and pause high lifts." : "Check trench pumps and haul road drainage.",
        severity: "warning", status: "open", source: "weather", createdAt: ts,
      });
      await ctx.db.insert("actionItems", {
        siteId: site._id, alertId,
        title: windy ? "Secure loose materials" : "Check pumps and drainage",
        assignee: "Ground crew", priority: "urgent", status: "open", createdAt: ts,
      });
      notes.push(windy ? "Wind advisory for " + site.name : "Rain cell over " + site.name);
    } else if (roll < 0.68 && machine) {
      // service completed
      await ctx.db.patch(machine._id, { status: "operational", health: Math.min(100, machine.health + 10), nextServiceHours: 500, engineTempC: 86 });
      await log("maintenance", `${machine.name} — service completed`, "Interval service signed off. Back to full duty.", "info", "Site mechanic");
      notes.push(`${machine.name} serviced and back to work`);
    } else if (roll < 0.84 && machine) {
      // routine telemetry snapshot
      const temp = 80 + Math.floor(Math.random() * 12);
      const fuel = Math.max(15, machine.fuelPct - Math.floor(Math.random() * 18));
      await ctx.db.patch(machine._id, { engineTempC: temp, fuelPct: fuel, hours: machine.hours + 2 });
      await log("telemetry", `${machine.name} — shift snapshot`, `Engine ${temp}°C, fuel ${fuel}%, +2 hrs. Within normal band.`, "info", "Telemetry feed");
      notes.push(`Telemetry snapshot stored for ${machine.name}`);
    } else {
      // crew interaction
      const who = pick(["J. Alvarez, Operator", "T. Okafor, Foreman", "M. Ruiz, Mechanic"]);
      const note = pick([
        "Grade stakes moved on the east pad — re-surveyed.",
        "Fuel truck on site, tanks topped.",
        "Switchgear inspection done, no issues.",
      ]);
      await log("interaction", "Crew note logged", note, "info", who);
      notes.push(`Crew note from ${who.split(",")[0]}`);
    }
    return { notes };
  },
});

// ---- CAT engineering loop ----

export const saveInvestigation = mutation({
  args: { reportId: v.id("engineerReports"), notes: v.string() },
  handler: async (ctx, { reportId, notes }) => {
    const report = await ctx.db.get(reportId);
    if (!report) throw new Error("Report not found");
    const status = report.status === "new" ? "investigating" : report.status;
    await ctx.db.patch(reportId, {
      investigation: report.investigation ? `${report.investigation}\n${notes}` : notes,
      status,
      updatedAt: now(),
    });
  },
});

export const provideQuickFix = mutation({
  args: { reportId: v.id("engineerReports"), quickFix: v.string() },
  handler: async (ctx, { reportId, quickFix }) => {
    const report = await ctx.db.get(reportId);
    if (!report) throw new Error("Report not found");
    await ctx.db.patch(reportId, { quickFix, status: "quick_fix", updatedAt: now() });
    const machine = report.machineId ? await ctx.db.get(report.machineId) : null;
    const ts = now();
    const fixAlertId = await ctx.db.insert("alerts", {
      siteId: report.siteId,
      machineId: report.machineId,
      category: "mechanical",
      title: `Quick fix available — ${machine?.name ?? "machine"}`,
      message: quickFix,
      severity: "info",
      status: "open",
      source: "service",
      createdAt: ts,
    });
    await ctx.db.insert("events", {
      siteId: report.siteId,
      machineId: report.machineId,
      kind: "fix",
      title: `Quick fix from CAT Engineering`,
      detail: quickFix,
      severity: "info",
      actor: "CAT Engineering",
      createdAt: ts,
    });
    await ctx.db.insert("actionItems", {
      siteId: report.siteId,
      alertId: report.alertId,
      title: "Apply the quick fix",
      detail: quickFix,
      assignee: "Site mechanic",
      priority: "urgent",
      status: "open",
      createdAt: ts,
    });
    return fixAlertId;
  },
});

export const resolveInUpdate = mutation({
  args: { reportId: v.id("engineerReports"), productUpdate: v.string() },
  handler: async (ctx, { reportId, productUpdate }) => {
    const report = await ctx.db.get(reportId);
    if (!report) throw new Error("Report not found");
    await ctx.db.patch(reportId, {
      productUpdate,
      status: "resolved",
      updatedAt: now(),
    });
    const ts = now();
    const alert = await ctx.db.get(report.alertId);
    if (alert && alert.status !== "resolved") {
      await ctx.db.patch(report.alertId, {
        status: "resolved",
        resolvedAt: ts,
        resolution: `Fixed in product update: ${productUpdate}`,
      });
      const open = await ctx.db
        .query("actionItems")
        .withIndex("by_alert", (q) => q.eq("alertId", report.alertId))
        .collect();
      for (const t of open)
        if (t.status === "open")
          await ctx.db.patch(t._id, { status: "done", completedAt: ts });
    }
    await ctx.db.insert("events", {
      siteId: report.siteId,
      machineId: report.machineId,
      kind: "update",
      title: "Product update shipped",
      detail: productUpdate,
      severity: "info",
      actor: "CAT Engineering",
      createdAt: ts,
    });
  },
});

// ---- voice reports (processed by ai.ts, committed here) ----

export const siteContext = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    const machines = await ctx.db
      .query("machines")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .collect();
    return { siteName: site?.name ?? "", machines: machines.map((m) => m.name) };
  },
});

export const machineIdByName = query({
  args: { siteId: v.id("sites"), name: v.string() },
  handler: async (ctx, { siteId, name }) => {
    const machines = await ctx.db
      .query("machines")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .collect();
    const m = machines.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return m?._id ?? null;
  },
});

export const commitVoiceReport = mutation({
  args: {
    siteId: v.id("sites"),
    machineId: v.optional(v.id("machines")),
    category: v.string(),
    severity: v.string(),
    title: v.string(),
    crewMessage: v.string(),
    transcript: v.string(),
    actor: v.string(),
    actions: v.array(v.string()),
  },
  handler: async (
    ctx,
    { siteId, machineId, category, severity, title, crewMessage, transcript, actor, actions },
  ) => {
    const ts = now();
    const alertId = await ctx.db.insert("alerts", {
      siteId,
      machineId,
      category,
      title,
      message: crewMessage,
      severity,
      status: "open",
      source: "crew",
      createdAt: ts,
    });
    // the raw transcript is the memory; the AI summary rides on the alert
    await ctx.db.insert("events", {
      siteId,
      machineId,
      kind: "alert",
      title: `Voice report: ${title}`,
      detail: `“${transcript}”`,
      severity,
      actor,
      createdAt: ts,
    });
    if (category === "mechanical") {
      await ctx.db.insert("engineerReports", {
        alertId,
        siteId,
        machineId,
        title,
        symptom: `Spoken report from ${actor}: “${transcript}”`,
        severity,
        status: "new",
        createdAt: ts,
        updatedAt: ts,
      });
    }
    for (const action of actions) {
      await ctx.db.insert("actionItems", {
        siteId,
        alertId,
        title: action,
        assignee: "Crew",
        priority: severity === "critical" ? "urgent" : "routine",
        status: "open",
        createdAt: ts,
      });
    }
    return alertId;
  },
});
