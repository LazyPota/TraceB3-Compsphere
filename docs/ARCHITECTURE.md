# TRACEB3 Backend Architecture

TRACEB3 is a hybrid Web2/Web3 **Digital Waste Passport** for industrial hazardous waste (B3) piloted for **Jababeka Cikarang Industrial Estate**. It **complements** existing Indonesian compliance systems (**Festronik**, **MONIJA**) by adding a shared, **tamper-evident**, append-only custody trail across generators, transporters, treatment facilities, and regulators.

---

## 1. High-Level Topology

```text
Next.js + wagmi Frontend (separate repo)
   │  JSON / HTTPS + SIWE (EIP-4361) + EIP-712 signatures
   ▼
Hono OpenAPI Server (apps/api)
   ├──▶ PostgreSQL (PGlite local / Supabase Postgres)
   │      ├── Append-only triggers + RLS deny-all policies
   │      └── Outbox queue (chain_jobs) + idempotency_records + audit_log
   ├──▶ Private Object Storage (LocalFsStorage / SupabaseStorage)
   │      └── Magic-byte checked uploads + streaming SHA-256 + signed URLs
   ├──▶ Single-Concurrency Chain Relay Worker (apps/api/src/chain/relayer.ts)
   │      └── simulateContract -> writeContract -> receipt -> authoritative block.timestamp
   ├──▶ Chain-Log Reconciler (apps/api/src/jobs/reconciler.ts)
   └──▶ Verification & Discrepancy Engine (packages/core + apps/api/src/services/verification.ts)
          │
          ▼
TraceB3Ledger.sol (EVM — Local Hardhat 31337 / Base Sepolia 84532)
```

---

## 2. Web2 / Web3 Trust Boundary

| Data Category | Stored Where | Why |
| :--- | :--- | :--- |
| Organization names, licenses, estate refs, member display names | PostgreSQL (off-chain) | Zero PII or commercial metadata on public blockchain |
| Waste manifests & weighbridge photos (`pdf`, `jpeg`, `png`, `webp`) | Private Storage (`LocalFsStorage` / `SupabaseStorage`) | Heavy binary files remain private and access-controlled |
| Full canonical custody event JSON + 16-byte random salt | PostgreSQL `custody_events.record` | Enables full re-canonicalization while salt prevents hash preimage guessing |
| `onChainBatchId = keccak256(utf8(batch_uuid))` | `TraceB3Ledger.sol` + DB | Deterministic, collision-resistant `bytes32` key without leaking internal refs |
| `onChainOrgId = keccak256(utf8(org_uuid))` | `TraceB3Ledger.sol` + DB | Anonymized `bytes32` org identifier for on-chain revision & custody checks |
| `eventHash = sha256(RFC8785(record))`, `prevHash`, `eventType`, `targetSeq`, `actor`, `block.timestamp` | `TraceB3Ledger.sol` (on-chain) | Public, **tamper-evident** cryptographic commitment and authoritative time |

---

## 3. Canonicalization, Hashing & Exact Weight Math (`@traceb3/core`)

- **Pure & Isomorphic:** `packages/core` uses zero Node built-ins (`viem` + Web Crypto `globalThis.crypto.getRandomValues`) so the future Next.js frontend and API execute identical logic.
- **Canonical Event Record (`v: 1`):** Explicit 16-field JSON structure (`v`, `batchId`, `seq`, `type`, `actorWallet`, `actorOrgId`, `fromOrgId`, `toOrgId`, `wasteCode`, `quantity`, `evidence` sorted by `sha256`, `targetSeq`, `reasonCode`, `notes`, `prevEventHash`, `salt`).
- **RFC 8785 (JCS):** Serialized deterministically via `canonicalize`, then hashed with SHA-256.
- **16-Byte Salt:** Prevents dictionary attacks against low-entropy payloads (e.g., `"850 kg of waste B105d"`) derived from public on-chain hashes.
- **Integer-Gram Unit Math:** All quantities in `kg`, `g`, or `ton` are parsed as exact decimal strings into `bigint` grams (`kg` = 3 decimals, `g` = 0 decimals, `ton` = 6 decimals). Sub-gram precision throws `UnitNormalizationError`. IEEE-754 floats are never used.

---

## 4. Gasless Custody Flow (`INTENT -> SIGN -> SUBMIT -> RELAY`)

```mermaid
sequenceDiagram
    actor Actor as Actor Wallet (Generator/Transporter/Facility)
    participant API as Hono API (apps/api)
    participant DB as PostgreSQL + Outbox
    participant Relay as Single-Concurrency Relayer
    participant Chain as TraceB3Ledger.sol

    Actor->>API: POST /v1/intents { kind, batchId?, data, evidenceIds }
    API->>Chain: read nonces(actor)
    API->>API: Validate transition, normalize grams, build RFC8785 record + eventHash
    API-->>Actor: 201 { intentId, typedData, eventPreview, expiresAt }
    Actor->>Actor: Sign EIP-712 CustodyIntent via wallet (0 gas)
    Actor->>API: POST /v1/intents/:id/submit (Idempotency-Key) { signature }
    API->>API: Verify EIP-712 signature & consume intent
    API->>DB: TX: insert custody_events(PENDING) + bind evidence + enqueue chain_jobs
    API-->>Actor: 202 { eventId, status: "PENDING" }
    Relay->>Chain: simulateContract(...)
    Relay->>Chain: writeContract(...) -> waitForTransactionReceipt
    Relay->>Chain: getBlock(blockNumber) -> authoritative block.timestamp
    Relay->>DB: TX: custody_events(ANCHORED) + update batch status/discrepancies + chain_jobs(CONFIRMED)
```

- **Max 1 In-Flight Event Per Batch:** Attempting `POST /v1/intents` while an event is `PENDING` or `SUBMITTED` returns `409 BATCH_BUSY`.
- **Single-Concurrency Mutex:** Both custody anchor writes and admin actor registry writes share a FIFO mutex so the relayer wallet never suffers nonce collisions.
- **Permissionless Relay (Censorship Resistance):** Because `TraceB3Ledger` authenticates the actor via EIP-712 signature + on-chain `Nonces`, *any* address (relayer by default, or the actor themselves as fallback) can submit a signed `CustodyIntent`.

---

## 5. Verification & Discrepancy Semantics

- **Discrepancy Engine:** Evaluates effective quantities (latest `REVISION` overrides target base event weight while preserving original events and emitting `VALUE_REVISED` `info`). Checks `WEIGHT_MISMATCH_PICKUP`, `WEIGHT_MISMATCH_DELIVERY`, `WEIGHT_MISMATCH_TOTAL` (configurable `WEIGHT_TOLERANCE_PCT`, default `2%`; `> 2%..10%` `warning`, `> 10%` `critical`), `LIKELY_UNIT_ERROR` (within 1% of `10^3` or `10^-3`, `critical`), and `CUSTODY_GAP` (`CUSTODY_GAP_HOURS`).
- **Verification Service:** Re-canonicalizes DB `record` -> SHA-256 vs on-chain `getEvent`, validates `prevEventHash` chain continuity, verifies EIP-712 signatures, re-streams stored evidence files to verify SHA-256, and checks on-chain `eventCount` for deleted DB rows. Any mutation produces `TAMPERED` naming exact `affectedEvents` / `affectedFiles`.
