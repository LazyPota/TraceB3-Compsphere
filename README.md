# TRACEB3 — Digital Waste Passport Backend

Hybrid Web2/Web3 **Digital Waste Passport** backend for industrial hazardous waste (**B3**) in Indonesia, piloted for **Jababeka Cikarang Industrial Estate** (*HackSphere 2026*).

TRACEB3 **complements** existing government and industrial compliance systems (**Festronik**, **MONIJA**) with a shared, **tamper-evident**, append-only custody trail backed by PostgreSQL, private evidence storage, and **TraceB3Ledger** on EVM (local Hardhat / Base Sepolia).

---

## Architecture Overview

```text
Next.js + wagmi Frontend ──JSON/HTTPS + SIWE + EIP-712──▶ Hono API (apps/api)
                                                              │
       ┌──────────────────────────────────────────────────────┼─────────────────────────────┐
       ▼                                                      ▼                             ▼
PostgreSQL (PGlite / Supabase)                     Private Storage (Local / Supabase)   Chain Relay Worker + Reconciler
  (append-only triggers, RLS, outbox)                (magic-byte check, SHA-256)          (single-concurrency FIFO mutex)
                                                                                                   │
                                                                                                   ▼
                                                                                          TraceB3Ledger.sol (EVM)
```

---

## 5-Minute Quickstart

### Prerequisites
- Node.js `>= 22.13.0` (Node 22 LTS or 24)
- `pnpm` (`>= 10`)

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Boot Full Local Stack (Hardhat + Contract + PGlite + API + Demo Seed)
```bash
pnpm dev:all
```
- API Server: `http://127.0.0.1:3001`
- Interactive Scalar API Docs: `http://127.0.0.1:3001/docs`
- OpenAPI 3.1 JSON: `http://127.0.0.1:3001/openapi.json`
- Demo wallets are saved in `.env.demo` (gitignored).

### 3. Run End-to-End Custody & Tamper Verification Demo
```bash
# Against the stack started by `pnpm dev:all`:
pnpm demo:e2e

# Or completely self-hosted in one command (ephemeral Hardhat + API):
pnpm demo:e2e -- --self-hosted
```

---

## Workspace Layout

| Path | Package | Description |
| :--- | :--- | :--- |
| [`packages/core`](file:///d:/Project/TraceB3-Compsphere/packages/core/package.json) | `@traceb3/core` | Pure, zero-IO browser/Node shared lib: RFC 8785 canonicalization, SHA-256/Keccak256 hashing, `bigint` integer-gram normalization, EIP-712 definitions, Zod v4 schemas, state machine, discrepancy engine |
| [`packages/contracts`](file:///d:/Project/TraceB3-Compsphere/packages/contracts/package.json) | `@traceb3/contracts` | Hardhat 3 + OpenZeppelin v5 `TraceB3Ledger.sol`, invariant test suite, deploy scripts, typed ABI & address exports |
| [`packages/sdk`](file:///d:/Project/TraceB3-Compsphere/packages/sdk/package.json) | `@traceb3/sdk` | End-to-end typed `hono/client` wrapper (`createTraceB3Client`) + re-exported core & contract helpers |
| [`apps/api`](file:///d:/Project/TraceB3-Compsphere/apps/api/package.json) | `@traceb3/api` | Hono + OpenAPI API server, Drizzle dual-mode DB (`pglite://` & `postgres://`), storage adapters, SIWE auth, single-concurrency relayer, reconciler, verification service |
| [`scripts/`](file:///d:/Project/TraceB3-Compsphere/scripts/dev-all.ts) | — | `dev-all.ts`, `seed.ts`, `e2e-demo.ts`, `tamper-demo.ts`, `verify-bundle.ts` |

---

## Standard Commands

- `pnpm build` — Compile contracts, export ABI, and build all TypeScript packages
- `pnpm typecheck` — Strict TypeScript checking across source and tests
- `pnpm lint` — ESLint across the workspace
- `pnpm test` — Run `@traceb3/core`, `@traceb3/contracts`, `@traceb3/sdk`, and `@traceb3/api` test suites
- `pnpm dev:all` — Start local Hardhat chain, deploy `TraceB3Ledger`, migrate PGlite, start API, and seed demo actors
- `pnpm demo:e2e` — Execute full multi-actor custody lifecycle + discrepancy + revision + treatment + tamper verification
- `pnpm verify:bundle -- --file bundle.json --rpc <RPC_URL>` — Verify a portable proof bundle directly against EVM RPC

---

## Documentation

- [Architecture Guide](file:///d:/Project/TraceB3-Compsphere/docs/ARCHITECTURE.md)
- [HTTP API Reference](file:///d:/Project/TraceB3-Compsphere/docs/API.md)
- [Frontend Handoff Guide (Next.js + wagmi)](file:///d:/Project/TraceB3-Compsphere/docs/FRONTEND_HANDOFF.md)
- [Live Demo Script](file:///d:/Project/TraceB3-Compsphere/docs/DEMO_SCRIPT.md)
- [Security & Threat Model](file:///d:/Project/TraceB3-Compsphere/docs/SECURITY.md)
- [Engineering Assumptions & Scope](file:///d:/Project/TraceB3-Compsphere/docs/ASSUMPTIONS.md)
