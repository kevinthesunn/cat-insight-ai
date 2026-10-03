import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const ROLES = {
  OPERATOR: "operator",
  TECHNICIAN: "technician",
  MANAGER: "manager",
  ENGINEER: "engineer",
  ADMIN: "admin",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.OPERATOR),
  v.literal(ROLES.TECHNICIAN),
  v.literal(ROLES.MANAGER),
  v.literal(ROLES.ENGINEER),
  v.literal(ROLES.ADMIN),
);
export type Role = (typeof ROLES)[keyof typeof ROLES];

const embedding = v.array(v.number());

const schema = defineSchema(
  {
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()), // do not remove
      image: v.optional(v.string()), // do not remove
      email: v.optional(v.string()), // do not remove
      emailVerificationTime: v.optional(v.number()), // do not remove
      isAnonymous: v.optional(v.boolean()), // do not remove
      role: v.optional(roleValidator),
      siteId: v.optional(v.id("sites")), // null for engineers/admin
      defaultMachineId: v.optional(v.id("machines")), // "last used" machine
    }).index("email", ["email"]),

    // ---- §6 core ----
    sites: defineTable({
      name: v.string(),
      region: v.optional(v.string()),
      createdAt: v.number(),
    }),

    machines: defineTable({
      serialNumber: v.string(),
      unitNumber: v.optional(v.string()), // what crews call it ("Unit 14")
      model: v.string(), // "336", "D8"
      machineClass: v.string(), // excavator | dozer
      siteId: v.id("sites"),
      qrTag: v.optional(v.string()),
      assetId: v.optional(v.id("assets")),
      createdAt: v.number(),
    }).index("by_site", ["siteId"]),

    // §17.1 asset tree: site → machine → system → component instance
    assets: defineTable({
      parentId: v.optional(v.id("assets")),
      kind: v.union(
        v.literal("site"),
        v.literal("machine"),
        v.literal("system"),
        v.literal("component"),
      ),
      name: v.string(),
      serialNumber: v.optional(v.string()),
      partNumber: v.optional(v.string()),
      model: v.optional(v.string()),
      installedAt: v.optional(v.number()),
      removedAt: v.optional(v.number()), // set when the component is replaced
      path: v.string(), // materialized path, e.g. "site1/m14/hyd/pump2"
      createdAt: v.number(),
    })
      .index("by_parent", ["parentId"])
      .index("by_path", ["path"]),

    machineStateSnapshots: defineTable({
      machineId: v.id("machines"),
      capturedAt: v.number(),
      engineHours: v.optional(v.number()),
      firmware: v.optional(v.string()),
      attachment: v.optional(v.string()),
      extra: v.optional(v.any()),
    }).index("by_machine", ["machineId"]),

    // ---- §6 episodic: immutable event log ----
    episodes: defineTable({
      machineId: v.id("machines"),
      siteId: v.optional(v.id("sites")),
      userId: v.optional(v.id("users")),
      assetId: v.optional(v.id("assets")), // most specific asset; defaults to the machine's
      kind: v.union(
        v.literal("voice_note"),
        v.literal("sensor_alarm"),
        v.literal("repair"),
        v.literal("inspection"),
        v.literal("correction"),
      ),
      occurredAt: v.number(),
      engineHours: v.optional(v.number()),
      rawText: v.optional(v.string()),
      audioUri: v.optional(v.string()),
      structured: v.optional(v.any()),
      extractionStatus: v.union(
        v.literal("pending"),
        v.literal("ok"),
        v.literal("failed"),
      ),
      signatureId: v.optional(v.id("faultSignatures")),
      supersedes: v.optional(v.id("episodes")),
      embedding: v.optional(embedding),
      idempotencyKey: v.optional(v.string()),
      redactedText: v.optional(v.string()),
      flaggedForEngineer: v.optional(v.boolean()),
      createdAt: v.number(),
    })
      .index("by_machine", ["machineId"])
      .index("by_signature", ["signatureId"])
      .index("by_idem", ["idempotencyKey"])
      .index("by_asset", ["assetId"]),

    // ---- §6 semantic ----
    faultSignatures: defineTable({
      machineClass: v.string(),
      modelFamily: v.optional(v.string()), // null = applies across models
      component: v.string(),
      faultCode: v.optional(v.string()),
      symptomSummary: v.string(),
      embedding: embedding,
      firstSeen: v.optional(v.number()),
      lastSeen: v.optional(v.number()),
    }).index("by_class", ["machineClass"]),

    repairs: defineTable({
      episodeId: v.id("episodes"),
      signatureId: v.optional(v.id("faultSignatures")),
      actionTaken: v.string(),
      parts: v.array(
        v.object({ name: v.string(), partNumber: v.optional(v.string()) }),
      ),
      durationMinutes: v.optional(v.number()),
      outcomeStatus: v.union(
        v.literal("pending"),
        v.literal("held"),
        v.literal("recurred"),
        v.literal("unknown"),
      ),
      outcomeResolvedAt: v.optional(v.number()),
      recurrenceEpisodeId: v.optional(v.id("episodes")),
    }).index("by_episode", ["episodeId"]),

    fixCards: defineTable({
      signatureId: v.id("faultSignatures"),
      title: v.string(),
      steps: v.array(v.string()),
      parts: v.array(v.string()),
      caveats: v.optional(v.string()),
      heldCount: v.number(),
      recurredCount: v.number(),
      pendingCount: v.number(),
      distinctUnits: v.number(),
      distinctSites: v.number(),
      lastUsedAt: v.optional(v.number()),
      version: v.number(),
      status: v.union(
        v.literal("active"),
        v.literal("retired"),
        v.literal("needs_review"),
      ),
      guidanceNote: v.optional(v.string()), // engineer "push guidance"
      guidanceBy: v.optional(v.string()),
      updatedAt: v.number(),
    }).index("by_signature", ["signatureId"]),

    fixCardEvidence: defineTable({
      fixCardId: v.id("fixCards"),
      repairEpisodeId: v.id("episodes"),
    }).index("by_card", ["fixCardId", "repairEpisodeId"]),

    feedback: defineTable({
      fixCardId: v.id("fixCards"),
      machineId: v.optional(v.id("machines")),
      userId: v.optional(v.id("users")),
      verdict: v.union(
        v.literal("worked"),
        v.literal("didnt_work"),
        v.literal("not_tried"),
      ),
      createdAt: v.number(),
    }).index("by_card", ["fixCardId"]),

    // ---- §6/§12 engineer view ----
    patternClusters: defineTable({
      signatureId: v.optional(v.id("faultSignatures")),
      windowStart: v.optional(v.number()),
      windowEnd: v.optional(v.number()),
      unitCount: v.number(),
      siteCount: v.number(),
      episodeCount: v.number(),
      baselineRate: v.optional(v.number()),
      observedRate: v.optional(v.number()),
      score: v.optional(v.number()),
      status: v.union(
        v.literal("new"),
        v.literal("investigating"),
        v.literal("known_issue"),
        v.literal("fixed_in_product"),
        v.literal("dismissed"),
      ),
      engineerNotes: v.optional(v.string()),
      sharedHints: v.optional(v.any()),
      updatedAt: v.number(),
    }).index("by_signature", ["signatureId"]),

    patternClusterMembers: defineTable({
      clusterId: v.id("patternClusters"),
      episodeId: v.id("episodes"),
    })
      .index("by_cluster", ["clusterId"])
      .index("by_episode", ["episodeId"]),

    // §13 audit log of raw reads
    auditLog: defineTable({
      actorId: v.optional(v.id("users")),
      action: v.string(),
      targetType: v.string(),
      targetId: v.optional(v.string()),
      createdAt: v.number(),
    }),

    // §17.3 manifest log
    manifests: defineTable({
      role: v.string(),
      intent: v.string(),
      anchors: v.array(v.id("assets")),
      items: v.optional(v.any()),
      widened: v.boolean(),
      answer: v.optional(v.any()),
      latencyMs: v.optional(v.number()),
      createdAt: v.number(),
    }),
  },
  { schemaValidation: false },
);

export default schema;
