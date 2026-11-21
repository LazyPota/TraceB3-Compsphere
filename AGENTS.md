# AGENTS.md — TRACEB3 Backend Repository Rules & Guide

## Product & Mission
TRACEB3 is a hybrid Web2/Web3 **Digital Waste Passport** for industrial hazardous waste (B3) in Indonesia, piloted for **Jababeka Cikarang Industrial Estate** (HackSphere 2026).
- **System Positioning:** Complements government and estate compliance platforms (**Festronik**, **MONIJA**); does not replace them.
- **Zero UI Scope:** This repository contains the backend API, shared pure core library, smart contracts, typed SDK, CLI demo/verification scripts, and documentation for the separate Next.js + `wagmi` frontend.
- **No Crypto Speculation:** Zero tokens, zero `payable` contract functions, zero speculative mechanics.

## Non-Negotiable Engineering Rules
1. **Tamper-Evident, NEVER "Tamper-Proof":**
   - Always describe TRACEB3 as providing a shared, **tamper-evident**, append-only custody history.
   - **NEVER** use the phrase `"tamper-proof"` in code, comments, tests, or documentation. The blockchain proves data did not change *after* anchoring.
2. **Zero Mocks in the Demo Path:**
   - Every custody handoff, signature check, hash check, file stream check, and verification step must execute against real PostgreSQL (PGlite or Supabase Postgres), real storage (`LocalFsStorage` or `SupabaseStorage`), and real EVM contract state (local Hardhat or Base Sepolia).
3. **Verify Current Library Documentation:**
   - Do not rely on stale memory for `Hardhat` (v3 ESM + viem toolbox), `viem` (`viem/siwe`), `OpenZeppelin v5`, `Hono`, `@hono/zod-openapi` (Zod v4), `Drizzle ORM` (`postgres-js` & `pglite`), or `@supabase/supabase-js`.
4. **Data Integrity & Security Invariants:**
   - **Authoritative Time:** On-chain `block.timestamp` is authoritative for anchored custody records.
   - **Server-Side Hashing:** Evidence SHA-256 is computed server-side while streaming uploads; never trust client-supplied hashes, weights, or timestamps.
   - **Exact Quantities:** Normalize weights to integer grams (`bigint` / exact decimal parsing). **Never use IEEE-754 floats** for waste quantities.
   - **Dual Authorization:** Permissions are enforced independently in both the Hono API and `TraceB3Ledger.sol`.
   - **No On-Chain PII:** Only cryptographic hashes, role enums, addresses, timestamps, and sequence numbers go on-chain.
   - **Secret Hygiene:** Never commit `.env`, `.env.demo`, private keys, or service-role keys. Never log `RELAYER_PRIVATE_KEY`, `JWT_SECRET`, or `SUPABASE_SERVICE_ROLE_KEY`.
5. **Phase-Gated Workflow & Escalation Policy:**
   - Every phase ends with `pnpm typecheck`, `pnpm lint`, and `pnpm test` passing, followed by a Conventional Commit and updated artifacts.
   - Only ask the user before: (1) changing the frozen EIP-712 definition or contract ABI after Phase 2, (2) spending real money or touching mainnet, (3) adding paid external services, or (4) requesting secrets (Base Sepolia RPC URL + funded relayer private key for Phase 6).
   - For all other engineering decisions, choose a sensible default and record it in `docs/ASSUMPTIONS.md`.

## Repository Layout
```text
.
├── AGENTS.md
├── .agents/rules/traceb3.md
├── docs/                  # Architecture, API, Frontend Handoff, Demo Script, Security, Assumptions
├── packages/
│   ├── core/              # Pure, zero-IO: RFC 8785 canonicalization, hashing, unit math, EIP-712, Zod schemas, state machine, discrepancy engine
│   ├── contracts/         # Hardhat 3 + TraceB3Ledger.sol + tests + deploy + exports/ (ABI & chain addresses)
│   └── sdk/               # Typed Hono RPC client + core/contract re-exports
├── apps/
│   └── api/               # Hono + OpenAPI + Drizzle + StorageAdapter + SIWE + Relayer + Verification + Reconciler
└── scripts/               # seed.ts, dev-all.ts, e2e-demo.ts, tamper-demo.ts, verify-bundle.ts
```

## Architecture Summary
- **Identity & Auth:** B2B registry managed exclusively by `ADMIN`. Authentication uses SIWE (EIP-4361 via `viem/siwe`) issuing short-lived JWTs carrying `{ address, memberId, orgId, role }`.
- **Gasless Custody Flow (`INTENT -> SIGN -> SUBMIT`):** `POST /v1/intents` builds canonical event data + EIP-712 typed data -> user signs client-side -> `POST /v1/intents/:id/submit` (with `Idempotency-Key`) verifies signature and atomically writes `custody_events` (`PENDING`) + `chain_jobs` outbox -> single-concurrency Chain Relay Worker simulates, submits, and updates `ANCHORED` with block timestamp. Maximum 1 in-flight event per batch (`409 BATCH_BUSY`).
- **Verification & Discrepancies:** Verification recomputes RFC 8785 canonical SHA-256 against the chain, checks EIP-712 signatures, checks `prevHash` continuity, and re-hashes stored evidence blobs from storage. Discrepancies operate on latest effective revised weights while preserving all original events.

## Standard Commands
- `pnpm install` — Install workspace dependencies
- `pnpm build` — Build all packages and apps
- `pnpm typecheck` — Run TypeScript typechecking across the workspace
- `pnpm lint` — Run ESLint across the workspace
- `pnpm test` — Run all unit, contract, and integration test suites
- `pnpm test:core` / `pnpm test:contracts` / `pnpm test:api` — Run targeted package tests
- `pnpm dev:all` — Start local Hardhat chain, deploy contract, migrate DB, start API, and seed demo data
