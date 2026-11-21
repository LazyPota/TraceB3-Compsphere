# Engineering Assumptions & Decisions Log

This file records engineering defaults chosen in accordance with the TRACEB3 operating protocol, plus explicit accounting of shipped P0/P1 features and deferred P2 items.

## Scope & Priority Accounting (Final Status)
- **P0 (Mandatory):** **100% Shipped & Verified** (`@traceb3/core`, `TraceB3Ledger.sol`, deploy + exports, Drizzle schema + triggers + RLS, `StorageAdapter` `LocalFsStorage` & `SupabaseStorage`, SIWE auth, Admin org/member registry, `INTENT -> SIGN -> SUBMIT`, evidence upload + streaming SHA-256 + magic bytes, single-concurrency relayer + outbox, discrepancy engine, full verification service, public passports, QR PNG/SVG, `seed.ts`, `e2e-demo.ts`, OpenAPI 3.1 + Scalar `/docs`, `FRONTEND_HANDOFF.md`).
- **P1 (After P0):** **100% Shipped & Verified** (`recordTreatment` API + contract wiring, `ChainReconciler`, `POST /v1/dev/seed` & `POST /v1/dev/tamper`, portable proof bundle + RPC-only `scripts/verify-bundle.ts`, `audit_log` + `GET /v1/audit-logs`, SSE `GET /v1/events/:id/stream`, `@traceb3/sdk` typed `hono/client`, rate-limiting middleware).
- **P2 (Optional — Deferred):** The following P2 items are intentionally omitted to maintain focus on P0/P1 quality and stability:
  - Festronik/MONIJA external REST/webhook integration adapter (schema already includes `festronik_ref` and `monija_ref` reference columns ready for future adapters).
  - ERC-1271 smart-contract wallet EIP-712 verification inside `TraceB3Ledger.sol` (SIWE login via `viem/siwe` already supports ERC-1271/6492, while on-chain `CustodyIntent` uses EOA `ECDSA.tryRecoverCalldata`).
  - Two-phase handover (sender release + receiver accept).
  - GPS coordinate capture at QR scan.
  - Outbound webhooks.

---

## Architectural & Engineering Defaults

1. **Local PostgreSQL Engine (`pglite://` + `postgres://` Parity):**
   - **Context:** Docker is not installed on the development host.
   - **Decision:** `apps/api` supports both `postgres://` / `postgresql://` (`postgres.js` + `drizzle-orm/postgres-js`) and `pglite://` (`@electric-sql/pglite` + `drizzle-orm/pglite`). Both run the exact same Drizzle schema, SQL migrations, append-only triggers, and RLS policies.
   - **Trade-off:** Disk-backed PGlite allows a single active Node process at a time. `pnpm dev:all` therefore boots Hardhat -> deploys -> boots API -> seeds over HTTP (`POST /v1/dev/seed`), and demo scripts communicate strictly over HTTP.

2. **Browser-Compatible Zero-IO Core (`packages/core`):**
   - **Decision:** Uses `viem` and Web Crypto (`globalThis.crypto.getRandomValues`) instead of `node:crypto` so the Next.js + `wagmi` frontend can import `@traceb3/core` directly.

3. **Pre-Frozen `recordTreatment` in Phase 2 Contract:**
   - **Decision:** Included `recordTreatment` (`eventType = 3`) in `TraceB3Ledger.sol` before freezing the Phase 2 ABI so P1 wiring required zero ABI or EIP-712 changes.

4. **1-Based On-Chain Sequence Numbers:**
   - **Decision:** `TraceB3Ledger.getEvent(bytes32 batchId, uint32 seq)` and DB `custody_events.seq` both use 1-based sequence numbers (`seq >= 1`). `targetSeq = 0` unambiguously means non-revision.

5. **Revision Semantics & Effective Discrepancy Status:**
   - **Decision:** A `REVISION` targets an existing non-revision base event from the same `orgId`. Discrepancies evaluate the latest revision's effective weight while preserving all original events and emitting `VALUE_REVISED` (`info`). When weight mismatches are resolved via revision and only `VALUE_REVISED` remains, `has_discrepancy` is `false` and `max_discrepancy_severity` is `'info'`.

6. **Evidence Staging Before Batch Creation:**
   - **Decision:** `evidence_files.batch_id` is nullable and `POST /v1/batches/staging/evidence` accepts uploads before batch creation. Submitting the `CREATED` intent atomically binds `batch_id` and `event_id`.

7. **Serialized Relayer Execution Queue:**
   - **Decision:** Both custody event relay jobs (`chain_jobs`) and admin `registerActor` / `revokeActor` transactions execute through a single FIFO mutex (`ChainRelayWorker.enqueueExclusive`) so the relayer wallet never encounters nonce collisions.

8. **Demo Tamper Simulation (`POST /v1/dev/tamper`):**
   - **Decision:** `mode: "db"` runs inside a transaction that temporarily disables `trg_custody_events_append_only`, mutates `custody_events.record`, and immediately re-enables the trigger in `finally` — simulating a compromised DBA while leaving triggers intact afterward.

9. **Zod v4 Alignment:**
   - **Decision:** `zod@^4.6.7` is aligned across `@traceb3/core` and `@traceb3/api` with `@hono/zod-openapi` v1.x.

10. **Local Dev Ephemeral Contract Deployments:**
    - **Decision:** `pnpm dev:all` and `--self-hosted` demo scripts deploy `TraceB3Ledger` dynamically from compiled artifacts and pass `LEDGER_ADDRESS` via environment/`.env.demo` without mutating tracked `packages/contracts/exports/addresses.json` (which records persistent deployments such as Base Sepolia).
