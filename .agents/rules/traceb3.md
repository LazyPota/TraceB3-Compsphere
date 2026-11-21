# TRACEB3 Workspace Rules

- **Terminology:** Always describe TRACEB3 as **tamper-evident** (never "tamper-proof"). The blockchain proves data was not altered after anchoring.
- **Zero Mocks:** Never use static mocks in the demo path. All custody events, hashes, signatures, storage reads, and chain operations must execute against real DB, storage, and EVM state.
- **No Speculation:** Zero tokens, zero `payable` functions, zero speculative mechanics.
- **Math & Hashing:** Use `bigint` / exact decimal parsing for integer grams (`kg | g | ton`, no floats). Use RFC 8785 (`canonicalize`) + SHA-256 for event records and server-side streaming SHA-256 for evidence uploads.
- **Authoritative Time:** Always record and trust on-chain `block.timestamp` over server clocks for anchored events.
- **Shared Source of Truth:** All enums, EIP-712 types, Zod schemas, canonicalization, unit normalization, state transitions, and discrepancy logic live in `@traceb3/core` (`packages/core`) and are consumed by both backend and frontend.
- **Frozen Contract Boundary:** Once Phase 2 completes, do not alter `TraceB3Ledger` ABI or `CustodyIntent` EIP-712 types without explicit user approval.
- **Assumptions Log:** Record any non-trivial engineering defaults in `docs/ASSUMPTIONS.md`.
- **Gate Discipline:** Ensure `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass after every phase before committing with Conventional Commits.
