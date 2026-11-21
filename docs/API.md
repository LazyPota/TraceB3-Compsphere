# TRACEB3 HTTP API Reference

- **Base Path:** `/v1`
- **OpenAPI 3.1 Spec:** `GET /openapi.json`
- **Interactive Scalar UI:** `GET /docs`
- **Authentication:** `Authorization: Bearer <JWT>` (issued via SIWE `POST /v1/auth/verify`)
- **Error Format:** RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `code`, `requestId?`, `errors?`)

---

## 1. System & Health

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | Public | Database (`pglite`/`postgres`) and storage (`local`/`supabase`) health checks |
| `GET` | `/readyz` | Public | Full readiness: DB + storage + EVM RPC chainId match + `TraceB3Ledger` bytecode + relayer ETH balance > 0 |
| `GET` | `/v1/chain/info` | Public | Active `chainId`, `networkName`, `ledgerAddress`, `explorerBaseUrl` |
| `GET` | `/openapi.json` | Public | OpenAPI 3.1.0 JSON specification |
| `GET` | `/docs` | Public | Scalar interactive API reference |

---

## 2. Authentication (SIWE — EIP-4361)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/auth/nonce` | Public (rate-limited) | Generates single-use nonce (5-min TTL) bound to `SIWE_DOMAIN` and `CHAIN_ID` |
| `POST` | `/v1/auth/verify` | Public (rate-limited) | Verifies `{ message, signature }`, consumes nonce atomically, verifies active DB member, returns 1h HS256 JWT + member profile |
| `GET` | `/v1/auth/me` | Bearer JWT | Returns current authenticated member & organization profile |

---

## 3. Admin B2B Directory (`ADMIN` Only)

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/admin/organizations` | Create organization (`generator`, `transporter`, `facility`, `regulator`) and compute `onChainOrgId` |
| `POST` | `/v1/admin/members` | Register member wallet; operational roles (`GENERATOR`, `TRANSPORTER`, `FACILITY`) are registered on-chain via `TraceB3Ledger.registerActor` |
| `PATCH` | `/v1/admin/members/:id` | Update `displayName` or `status` (`ACTIVE` / `REVOKED`); syncs operational roles on-chain via `revokeActor` / `registerActor` |

---

## 4. Evidence Upload & Signed Downloads

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/batches/:id/evidence` | `GENERATOR`, `TRANSPORTER`, `FACILITY`, `ADMIN` | `multipart/form-data` (`file`, optional `label`). Pass `:id=staging` prior to `CREATED`. Validates magic bytes (`pdf`, `jpeg`, `png`, `webp`), enforces `MAX_UPLOAD_MB`, computes streaming SHA-256 |
| `GET` | `/v1/evidence/:id/download` | Bearer JWT (authorized org, `ADMIN`, or `AUDITOR`) | Returns 120s signed download URL + expected SHA-256 |
| `GET` | `/v1/evidence/signed/:token` | Signed HMAC token | Streams private evidence blob with `Content-Disposition` (`LocalFsStorage` driver) |

---

## 5. Gasless Custody Flow (`INTENT -> SIGN -> SUBMIT`)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/intents` | `GENERATOR`, `TRANSPORTER`, `FACILITY` | Validates transition & quantity (`kg`/`g`/`ton`), reads on-chain nonce, builds canonical v1 record + `typedData`. Returns `409 BATCH_BUSY` if batch has an in-flight event |
| `POST` | `/v1/intents/:id/submit` | `GENERATOR`, `TRANSPORTER`, `FACILITY` | Requires `Idempotency-Key` header. Verifies EIP-712 signature, inserts `custody_events(PENDING)` + `chain_jobs`, binds staged evidence, triggers relayer. Returns `202` |
| `GET` | `/v1/events/:id/status` | Org participant, `ADMIN`, `AUDITOR` | Returns `chainStatus`, `txHash`, `blockNumber`, authoritative `anchoredAt`, `failureReason`, `explorerUrl` |
| `GET` | `/v1/events/:id/stream` | Org participant, `ADMIN`, `AUDITOR` | `text/event-stream` (SSE) emitting `status` events until `ANCHORED` or `FAILED` |

---

## 6. Batches, Discrepancies, QR & Audit Logs

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/batches` | Bearer JWT | Paginated list scoped to caller's org (or all orgs for `ADMIN`/`AUDITOR`). Query: `status`, `org`, `has_discrepancy`, `limit`, `offset` |
| `GET` | `/v1/batches/:id` | Org participant, `ADMIN`, `AUDITOR` | Full batch summary including `publicPassportUrl` and discrepancy flags |
| `GET` | `/v1/batches/:id/timeline` | Org participant, `ADMIN`, `AUDITOR` | Chronological events (`seq ASC`) with org metadata, evidence descriptors, `revisedBySeqs`, and raw canonical records |
| `GET` | `/v1/batches/:id/discrepancies` | Org participant, `ADMIN`, `AUDITOR` | Live discrepancy evaluation over effective revised quantities |
| `GET` | `/v1/batches/:id/qr` | Org participant, `ADMIN`, `AUDITOR` | Generates QR code (`?format=png` or `?format=svg`) encoding `${PUBLIC_APP_URL}/p/${publicId}` |
| `GET` | `/v1/audit-logs` | `ADMIN`, `AUDITOR` | Query compliance audit trail (`action`, `resourceType`, `limit`, `offset`) |

---

## 7. Public QR Passports & Verification (Rate-Limited)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/public/passports/:publicId` | Public | Returns passport summary & timeline; obeys `PUBLIC_VIEW_LEVEL=redacted\|full` (`redacted` omits weights, notes, and file manifests) |
| `GET` | `/v1/public/passports/:publicId/verify` | Public | Re-canonicalizes records, checks chain hashes, signatures, prevHash continuity, and re-hashes stored evidence blobs; returns `VERIFIED \| TAMPERED \| PENDING \| INCOMPLETE` |
| `GET` | `/v1/public/passports/:publicId/proof-bundle` | Public | Exports portable `ProofBundle` JSON verifiable trustlessly against any EVM RPC via `scripts/verify-bundle.ts` |

---

## 8. Demo Endpoints (`DEMO_MODE=true` Only)

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/dev/seed` | Idempotently seeds Jababeka demo organizations & 5 members and registers operational roles on-chain |
| `POST` | `/v1/dev/tamper` | Mutates either a DB event record (`mode: "db"`) or a stored evidence blob (`mode: "file"`) to demonstrate tamper-evident detection |

---

## 9. RFC 9457 Error Codes

| HTTP | `code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Schema, query, weight precision, or missing `Idempotency-Key` error |
| `400` | `BAD_SIGNATURE` | Invalid SIWE or EIP-712 signature |
| `401` | `UNAUTHENTICATED` | Missing/expired JWT, invalid/consumed SIWE nonce, or invalid signed token |
| `403` | `FORBIDDEN_ROLE` | Insufficient role, unregistered/revoked wallet, or cross-organization access |
| `404` | `NOT_FOUND` | Resource missing or `DEMO_MODE=false` for `/v1/dev/*` |
| `409` | `BATCH_BUSY` | Batch already has a `PENDING` or `SUBMITTED` custody event in flight |
| `409` | `INVALID_TRANSITION` | Disallowed custody state transition, duplicate code/wallet, or reused idempotency key mismatch |
| `410` | `INTENT_EXPIRED` | Custody intent deadline elapsed before `/submit` |
| `413` | `EVIDENCE_TOO_LARGE` | File exceeds `MAX_UPLOAD_MB` |
| `415` | `EVIDENCE_TYPE_NOT_ALLOWED` | Magic bytes do not match PDF, JPEG, PNG, or WebP |
| `422` | `CHAIN_REVERT` | Contract execution reverted on-chain |
| `429` | `RATE_LIMITED` | Rate limit exceeded (`Retry-After` header set) |
| `503` | `CHAIN_UNAVAILABLE` | RPC endpoint, contract address, or relayer unavailable |
