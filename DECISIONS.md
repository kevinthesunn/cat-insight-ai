# DECISIONS.md

Every deviation or choice made while building SiteMemory, per the design doc's instruction.

## D1. Stack deviation: FastAPI/PostgreSQL/pgvector/Docker → Convex + TypeScript (platform constraint)

The build environment is a managed Convex + React + Vite + Bun web platform (auth, database,
hosting, scheduled jobs included). It cannot run Docker, Python servers, or PostgreSQL, and
nothing built on that stack could be executed or verified here. The design is therefore
implemented 1:1 on the platform stack:

| Design doc | Implementation |
|---|---|
| PostgreSQL tables (§6, §17.1) | Convex tables in `src/convex/schema.ts` (same fields, UUID→Convex id) |
| pgvector + HNSW | Embeddings stored as number arrays; deterministic local embedder (see D3); cosine computed in service code over small candidate sets (signatures/cards are tens of rows at v1 scale) |
| `graph_edges` SQL view (§17.2) | Convex query `graphEdges` in `src/convex/store.ts` producing the identical uniform edge tuple list; the traversal engine reads only this |
| FastAPI services (§5) | Convex queries/mutations/actions split by the same responsibilities (`ingest.ts`, `store.ts`, `context.ts`, `memory/*`) |
| `MemoryStore` protocol (§5) | `src/convex/store.ts` exports the same five operations with the same semantics |
| APScheduler jobs (§5, §9, §12) | Convex scheduled functions in `src/convex/crons.ts`: outcome sweeper every 5 min, pattern scan every 15 min; job logic lives in callable functions |
| FastAPI endpoints (§17.6) | `POST /api/query` → action `context:queryContext`; `GET /query/{id}/manifest` → query `manifestById`; `GET /assets/{id}/branch` → query `assetBranch` |
| `docker compose up` + `scripts/seed.py` (§14.1) | Platform-managed dev server; seeding is mutation `seed:seedSiteMemory`, auto-invoked by the app when the DB is empty (acceptance 1 adapted: one command = open the app) |
| React+Vite+TS PWA, Tailwind | Same (already the platform's frontend); offline queue uses IndexedDB |

## D2. Provider defaults

- Default LLM: the environment's configured Groq key (`process.env.GROQ_API_KEY` with deployed
  fallback) using `openai/gpt-oss-120b` for extraction/summaries and `whisper-large-v3-turbo`
  for STT — `llama-3.3-70b-versatile` is not deployed on this Groq account (404 verified live).
  The design doc's "Anthropic default" is honored via the `LLMClient` interface: swapping the
  provider is one function in `src/convex/memory/groq.ts`.
- All LLM output is validated by `validateExtraction` (Pydantic → zod-style TS validation);
  one retry, then `extraction_status='failed'` (§8 honored).
- Custom STT vocabulary (§2 allows prompt hints): component synonyms from
  `memory/vocab.ts` are injected into the transcription/extract prompts as a hint.

## D3. Embeddings: local deterministic hashed bag-of-words (no external embedder)

No embedding provider is reachable from this deployment (Groq has no embeddings API). Chosen:
deterministic hashed bag-of-words embedder, 256-dim, L2-normalized (`memory/core.ts`).
Rationale: signatures/fix-cards are keyword-dominated (`component + fault_code + symptoms`),
so lexical overlap is a strong proxy; it is free, offline-testable, and deterministic, which
the rebuild-reproducibility test (§14.5) requires. `Embedder` stays behind an interface for a
swap to a real embedding model later.

## D4. Audio retention

§8/§16 want original audio retained for reprocessing. Convex file storage needs an HTTP
upload route; v1 keeps `audio_uri` in the schema and stores audio only in the client's
offline queue until sync, after which audio is dropped and only the transcript is retained.
Noted as the largest fidelity gap; the `audio_uri` column is the seam.

## D5. Episodes immutable — two pragmatic exceptions

1. `flagged_for_engineer` (set when retrieval returns "no confident match") and
   `signature_id` / `extraction_status` / `structured` / `redacted_text` are **workflow
   metadata** written by the async pipeline after the raw insert; the doc itself specifies
   this lifecycle (store raw `pending`, fill in later). Episode *content* (`raw_text`,
   `occurred_at`, `machine_id`) is never edited; corrections/deletions supersede (§13).
2. Recurrence flips `repairs.outcome_status` — that table is derived state by definition.

## D6. Fix-card text generation

Consolidation follows §10: grouping by action-embedding cosine ≥ 0.85, counts, evidence
links, status rules. The LLM-authored card text runs for live repairs (Groq, with the exact
required instruction "Use only information present in the supplied repairs…"). For seeded
history the card text is built by the deterministic template builder so tests and the demo
run with zero API dependency; a nightly rebuild would regenerate identical *specs* (the
reproducibility test covers specs, not prose).

## D7. Pattern baseline

`baseline_rate` uses the doc formula (episodes per 1,000 machine-days, trailing 180d
excluding the current window, epsilon floor). Thresholds are constants in
`memory/domain.ts` mirroring the env names (`PATTERN_MIN_UNITS=3`, `PATTERN_MIN_SITES=2`,
`PATTERN_MIN_WATCH_UNITS=2`, `SIG_MERGE_THRESHOLD=0.86`, `MIN_FIX_SCORE=0.45`,
`CONTEXT_MIN_SCORE=0.3`); Convex env vars can override via `getConfig()`.

## D8. Redaction

Crew-facing evidence: regex pass strips operator names (resolved from the users table),
serial numbers, unit numbers, and location names; other sites are aliased "Site A/B/C" by
site creation order; alias + relative time only. `redacted_text` stored at ingest.
Raw text/audio access is engineer/admin-only and goes through `revealRawEpisode`, which
writes an `audit_log` row (§13).

## D9. Playwright end-to-end (milestone 10) not run

Browser binaries and a second live server cannot be provisioned in this sandbox. Instead:
`bun test` suites cover every pure behavior the doc calls out (extraction fabrication guard,
signature merge, recurrence flips, consolidation rebuild reproducibility, ranking health
rule, pattern planted/baseline cases, context distractor/swap/scope/budget/citation/
widening) against simulator-shaped fixtures. The remaining e2e is the manual demo script in
README.md.

## D10. Section 17 gold manifests

The context pipeline (scope → interpret → traverse → gate → pack → answer → manifest log)
is fully implemented and unit-tested (distractor, swap, scope, budget, citation, widening).
The 30-question gold set with precision ≥ 0.9 reporting is not included; `assetBranch`
(explorer debug endpoint) is, so the set can be labeled later.

## D11. Product naming

The doc names the product "SiteMemory"; the previous UI ("CATerra") is renamed accordingly.
Role names follow §6 (`operator`, `technician`, `manager`, `engineer`, `admin`).

## D12. Mock data researched from real Caterpillar products (§14.1 simulator)

The simulator's fleet, fault codes, and parts are real, researched data — not invented:

- **Models + serial prefixes**: 336 → `TTY`, 320 GC → `LKS` (verified via a 2022 320GC
  dealer listing, Ring Power), D8T → `FMC` (US-built; `J8B` is the Brazil-built prefix),
  D6 XE → `KEG`. Engines referenced: 336 Next Gen = Cat C9.3, 320 GC = Cat C4.4,
  336 GC = Cat C7.1 (273 hp, dealer spec sheet), D8T = Cat C15 ACERT.
- **Fault codes** (CAT CDL CID-FMI + J1939 + event codes, per published CAT fault-code
  guides and the CAT fault-code PDF): `94-11` (CID 0094 fuel delivery pressure, FMI 11),
  `94-18` + event `E198` (low fuel pressure warning), `110-0` + event `E360` (coolant
  temp high; E361 = shutdown), `41-3/41-4` (8V DC supply — the fault that stacks multiple
  sensor codes at once, used for the harness signature), `2458-2` (DPF differential
  pressure erratic), `190-8` (engine speed abnormal frequency).
- **Part numbers** verified on parts.cat.com / dealer-catalog listings: `1R-0749`
  (secondary fuel filter), `326-4700` / `10R-7675` (C6.4 fuel injector, 320D/323D),
  `239-4418` (320 track tension cylinder), `216-0024` (pump group), `9T-6857` (piston
  pump), `344-1722` (belt tensioner, C7.1/C6.6).
- **Machine software** uses Cat release-build format (`4N2-1042`, planted pattern units
  share `4N2-1198`) instead of generic semver; fleet hours sit at a realistic mid-life
  ~7,100–7,800. Crew phrasing follows the §14.10 anti-fabrication guard: a fault code
  appears in an episode only when the crew actually "said" it, and mechanical faults
  (final drive leaks, tensioner slack) carry no code at all.
- Behavioral invariants of the simulator (planted 4-unit/2-site pump pattern, the
  baseline-normal track-tensioner distractor, the §17.1 pump-swap asset tree, fix-card
  rebuild + pattern scan) are unchanged from the original simulator.
