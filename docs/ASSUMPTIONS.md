# Engineering Assumptions & Decisions Log

This file records engineering defaults chosen in accordance with the TRACEB3 operating protocol. Any skipped P1/P2 items or subtle behavioral defaults are also documented here.

## Phase 0 — Tooling, Architecture & Environment Defaults

1. **Local PostgreSQL Engine (`pglite://` + `postgres://` Parity):**
   - **Context:** Docker is not installed on the development host.
   - **Decision:** `apps/api` supports both `postgres://` / `postgresql://` (via `postgres.js` + `drizzle-orm/postgres-js`) and `pglite://` (via `@electric-sql/pglite` + `drizzle-orm/pglite`). Both run the exact same Drizzle schema, SQL migrations, append-only PostgreSQL triggers, and RLS policies.
   - **Trade-off:** PGlite file-backed directories allow a single active Node process at a time. Therefore `pnpm dev:all` runs Hardhat -> contract deploy -> DB migration -> API startup -> HTTP seeding (`POST /v1/dev/seed`), and demo CLI scripts (`e2e-demo.ts`, `tamper-demo.ts`) always talk to the API over HTTP.

2. **Browser-Compatible Zero-IO Core (`packages/core`):**
   - **Decision:** Use `viem`'s `sha256` / `keccak256` and Web Crypto (`globalThis.crypto.getRandomValues`) instead of `node:crypto` so the future Next.js + `wagmi` frontend can import `@traceb3/core` directly without Node polyfills.

3. **Pre-Frozen `recordTreatment` in Phase 2 Contract:**
   - **Decision:** Include `recordTreatment` (`eventType = 3`) in `TraceB3Ledger.sol` during Phase 2 before freezing the ABI and EIP-712 types.
   - **Rationale:** Ensures P1 API wiring in Phase 5 requires zero ABI or EIP-712 modifications after the Phase 2 gate freeze.

4. **1-Based On-Chain Sequence Numbers:**
   - **Decision:** `TraceB3Ledger.getEvent(bytes32 batchId, uint32 seq)` and DB `custody_events.seq` both use **1-based** sequence numbers (`seq >= 1`). `targetSeq = 0` unambiguously means "not a revision".

5. **Revision Semantics & Effective Discrepancy Status:**
   - **Decision:** A `REVISION` event must reference an existing non-revision base event (`targetEvent.type !== 'REVISION'`) belonging to the same `orgId`. When computing discrepancies, the latest revision's quantity supersedes the original event's quantity, while `VALUE_REVISED` (`severity: 'info'`) is always emitted for audit transparency.
   - **Decision:** If all weight mismatches are resolved via revision and only `VALUE_REVISED` (`info`) remains, `has_discrepancy` is `false` and `max_severity` is `'info'`.

6. **Evidence Staging Before Batch Creation:**
   - **Decision:** Because `POST /v1/batches/:id/evidence` requires a batch ID while a `CREATED` batch does not exist until intent submission, `evidence_files.batch_id` is nullable and `POST /v1/batches/staging/evidence` allows uploading evidence prior to batch creation. Submitting the `CREATED` intent atomically binds `batch_id` and `event_id`.

7. **Serialized Relayer Execution Queue:**
   - **Decision:** Both custody event relay jobs (`chain_jobs`) and admin `registerActor` / `revokeActor` transactions execute through a single in-process FIFO mutex so the single relayer wallet never encounters nonce collisions.

8. **Demo Tamper Simulation (`POST /v1/dev/tamper`):**
   - **Decision:** Because `custody_events` has append-only database triggers (`trg_custody_events_append_only`), a DB tamper demo simulates a compromised DBA/superuser inside a single transaction by temporarily disabling the trigger, mutating the target event's `record`, and immediately re-enabling the trigger. This cleanly demonstrates why DB triggers are defense-in-depth while on-chain anchors provide true tamper evidence.

9. **Zod v4 Alignment:**
   - **Decision:** Use `zod` `^4` consistently across `@traceb3/core` and `@traceb3/api` to match `@hono/zod-openapi` v1.x.

10. **P2 Scope Status:**
    - P2 items (Festronik/MONIJA adapter stub, ERC-1271 smart-wallet signatures, two-phase handover, GPS capture, webhooks) are deferred until all P0 and P1 deliverables are complete and verified.
