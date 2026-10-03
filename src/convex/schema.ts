import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
  WORKER: "worker",
  MANAGER: "manager",
  ENGINEER: "engineer",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
  v.literal(ROLES.WORKER),
  v.literal(ROLES.MANAGER),
  v.literal(ROLES.ENGINEER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
      siteId: v.optional(v.id("sites")), // crew members are assigned to a job site
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ---- CATerra memory layer ----

    // Job sites where CAT assets operate.
    sites: defineTable({
      name: v.string(),
      location: v.string(),
      phase: v.string(), // e.g. "Earthworks", "Foundations", "Paving"
      status: v.string(), // "active" | "weather_hold"
      weatherCondition: v.string(), // "Clear" | "Rain" | "High wind" | ...
      weatherTempC: v.number(),
      windKph: v.number(),
      crewCount: v.number(),
      createdAt: v.number(),
    }),

    // CAT assets operating on a site.
    machines: defineTable({
      siteId: v.id("sites"),
      name: v.string(), // "320 GC Excavator"
      model: v.string(), // "320 GC"
      kind: v.string(), // "Excavator" | "Dozer" | ...
      serial: v.string(),
      status: v.string(), // "operational" | "idle" | "maintenance" | "down"
      health: v.number(), // 0-100 derived from the knowledge graph
      hours: v.number(),
      engineTempC: v.number(),
      fuelPct: v.number(),
      nextServiceHours: v.number(),
      createdAt: v.number(),
    }).index("by_site", ["siteId"]),

    // The ever-growing memory: every operational, maintenance, environmental
    // and interaction data point flowing in from the job site.
    events: defineTable({
      siteId: v.id("sites"),
      machineId: v.optional(v.id("machines")),
      kind: v.string(), // "telemetry" | "maintenance" | "environment" | "interaction" | "alert" | "fix" | "update"
      title: v.string(),
      detail: v.string(),
      severity: v.string(), // "info" | "warning" | "critical"
      actor: v.string(), // "Telemetry feed" | operator name | "CAT Engineering" | ...
      createdAt: v.number(),
    })
      .index("by_site", ["siteId"])
      .index("by_created", ["createdAt"])
      .index("by_machine", ["machineId"]),

    // Problems detected from data or reported by the crew.
    alerts: defineTable({
      siteId: v.id("sites"),
      machineId: v.optional(v.id("machines")),
      category: v.string(), // "mechanical" | "environmental" | "safety" | "operational"
      title: v.string(),
      message: v.string(), // plain language for the crew
      severity: v.string(), // "info" | "warning" | "critical"
      status: v.string(), // "open" | "acknowledged" | "resolved"
      source: v.string(), // "sensor" | "crew" | "weather" | "service"
      createdAt: v.number(),
      acknowledgedAt: v.optional(v.number()),
      resolvedAt: v.optional(v.number()),
      resolution: v.optional(v.string()),
    })
      .index("by_site", ["siteId"])
      .index("by_status", ["status"]),

    // Action items surfaced to the people on the job site.
    actionItems: defineTable({
      siteId: v.id("sites"),
      alertId: v.optional(v.id("alerts")),
      title: v.string(),
      detail: v.optional(v.string()),
      assignee: v.string(), // name or crew role, e.g. "All operators"
      priority: v.string(), // "routine" | "urgent"
      status: v.string(), // "open" | "done"
      createdAt: v.number(),
      completedAt: v.optional(v.number()),
    })
      .index("by_site", ["siteId"])
      .index("by_alert", ["alertId"])
      .index("by_status", ["status"]),

    // Mechanical issues escalated to CAT engineers for investigation.
    engineerReports: defineTable({
      alertId: v.id("alerts"),
      siteId: v.id("sites"),
      machineId: v.optional(v.id("machines")),
      title: v.string(),
      symptom: v.string(),
      severity: v.string(),
      status: v.string(), // "new" | "investigating" | "quick_fix" | "resolved"
      investigation: v.optional(v.string()),
      quickFix: v.optional(v.string()),
      productUpdate: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_status", ["status"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
