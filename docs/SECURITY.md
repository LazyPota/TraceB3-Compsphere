# TRACEB3 Security Architecture & Threat Model

TRACEB3 provides a **tamper-evident**, append-only custody audit log (proving records and manifest commitments were not altered after anchoring) for industrial hazardous waste.

---

## 1. Threat Model & Mitigations

| Threat | Mitigation |
| :--- | :--- |
| **Rogue DBA / Compromised SQL Admin edits `custody_events`** | 1. **Defense-in-Depth:** Trigger `trg_custody_events_append_only` rejects `DELETE` and rejects `UPDATE` on all immutable columns (`record`, `event_hash`, `prev_event_hash`, `signature`, etc.), and RLS is enabled with deny-all public policies.<br>2. **True Tamper Evidence:** Even if a superuser disables triggers (as demonstrated by `POST /v1/dev/tamper`), `verifyBatchIntegrity` and `verifyProofBundleAgainstRpc` re-canonicalize `record` and compare SHA-256 against immutable on-chain `TraceB3Ledger` hashes -> immediately exposing **`TAMPERED` / `HASH_MISMATCH`**. |
| **Swapped or corrupted manifest PDF / weighbridge image** | Upload SHA-256 is computed server-side during streaming (never trusted from client). Verification re-streams every blob from private storage and re-computes SHA-256 against the anchored manifest -> immediately exposing **`FILE_MISMATCH`** or **`FILE_MISSING`**. |
| **Malicious file type / MIME spoofing** | Uploaded files are verified by inspecting **magic bytes** (`%PDF-`, `FF D8 FF`, `89 50 4E 47`, `RIFF....WEBP`) rather than trusting `Content-Type`. Size capped at `MAX_UPLOAD_MB`. |
| **Unauthorized custody transition or cross-org forgery** | **Dual Authorization:** Enforced independently in Hono API (`requireAuth` + `requireRoles` + `validateCustodyTransition`) AND in `TraceB3Ledger.sol` (`_actors`, `ECDSA.tryRecoverCalldata`, role + org checks). |
| **Signature replay across batches, nonces, or chains** | EIP-712 domain pins `name="TraceB3Ledger"`, `version="1"`, `chainId`, and `verifyingContract`. Contract enforces per-actor sequential `_useCheckedNonce` and `block.timestamp <= deadline`. SIWE nonces are single-use (`used_at`) with a 5-minute TTL and domain + `chainId` binding. |
| **Preimage guessing on public on-chain hashes** | Every `CanonicalEventRecordV1` includes a cryptographically random 16-byte `salt` (`globalThis.crypto.getRandomValues`) before RFC 8785 + SHA-256 hashing. |
| **Relayer wallet censorship or availability** | Any third party holding a valid EIP-712 `CustodyIntent` + signature can submit directly to `TraceB3Ledger` (permissionless relay), and `ChainReconciler` repairs missed DB confirmations from on-chain logs. |
| **Floating-point rounding / unit confusion** | All quantities convert via exact decimal parsing to integer `bigint` grams. `LIKELY_UNIT_ERROR` catches `10^3` / `10^-3` discrepancies automatically. |
| **PII / commercial leaks on-chain or via public QR** | Zero PII goes on-chain (hashes/enums/addresses only). Public passports default to `PUBLIC_VIEW_LEVEL=redacted`, hiding weights, notes, and file links. Evidence storage is private with short-lived (`120s`) signed download URLs. |
| **Secret leakage in logs or git** | `.env` and `.env.demo` are gitignored; `pino` redacts `RELAYER_PRIVATE_KEY`, `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `Authorization`, and `*.privateKey`/`*.secret`/`*.token`. |
| **Brute-force / public scraping** | In-memory rate limiters guard `/v1/auth/*` and `/v1/public/*`, returning RFC 9457 `429 RATE_LIMITED` with `Retry-After`. |
