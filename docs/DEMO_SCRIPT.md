# TRACEB3 Live Demo Script (HackSphere 2026)

This script walks through the live backend demonstration on both **local Hardhat** and **Base Sepolia**. Every step runs against real PostgreSQL, real object storage, and real EVM contract state (zero mocks).

---

## Option A — Self-Hosted One-Command Verification

```bash
pnpm demo:e2e -- --self-hosted
```

This spins up an ephemeral Hardhat node + `TraceB3Ledger` + Hono API, runs all 9 steps end-to-end, prints every anchored transaction hash and tamper detection diff, and shuts down cleanly.

---

## Option B — Interactive Persistent Stack + Live Walkthrough

### 1. Boot the Full Local Stack
```bash
pnpm dev:all
```
Wait for the banner showing `http://127.0.0.1:3001/readyz`, `/docs`, `TraceB3Ledger` address, and seeded Jababeka actors (wallet keys stored in gitignored `.env.demo`).

### 2. Run the Full End-to-End Custody & Tamper Demo
In a second terminal:
```bash
pnpm demo:e2e
```
What happens live:
1. **SIWE Auth:** Each Jababeka actor (`GENERATOR`, `TRANSPORTER`, `FACILITY`, `AUDITOR`) signs an EIP-4361 login message and receives a scoped JWT.
2. **Batch Creation (`850 kg` + PDF Manifest):** Generator uploads a Festronik PDF (magic-byte checked, SHA-256 computed server-side), signs EIP-712 `CustodyIntent`, and the relayer anchors event #1 on `TraceB3Ledger`.
3. **Transporter Pickup (`850 kg` + PNG Weighbridge Photo):** Transporter signs custody handoff -> status transitions to `IN_TRANSIT`.
4. **Facility Delivery (`620 kg`) — Discrepancy Caught:** Facility records 620 kg -> Discrepancy Engine immediately flags `WEIGHT_MISMATCH_TOTAL` (`deltaKg: "230"`, `percent: 27.06`, `severity: "critical"`).
5. **Append-Only Revision (`845 kg`):** Facility signs a `REVISION` (`SCALE_RECALIBRATION`) targeting event #3. Original event #3 (`620 kg`) remains preserved in both DB and on-chain, while effective discrepancy clears (`VALUE_REVISED` `info` emitted).
6. **Treatment Completion:** Facility records `TREATMENT` -> status transitions to `TREATED`.
7. **Verification & Portable Proof Bundle:** `GET /v1/public/passports/:publicId/verify` returns **`VERIFIED`**, and `GET /v1/public/passports/:publicId/proof-bundle` verifies offline against RPC alone via `scripts/verify-bundle.ts`.
8. **Live Tamper Detection:**
   - File swap (`POST /v1/dev/tamper` `{ mode: "file" }`) -> Verify immediately returns **`TAMPERED`** naming **`FILE_MISMATCH`** on the exact evidence file.
   - Compromised DBA row edit (`POST /v1/dev/tamper` `{ mode: "db", eventSeq: 2 }`) -> Verify immediately returns **`TAMPERED`** naming **`HASH_MISMATCH`** on event #2.

### 3. Standalone CLI Demos (For Judges)
```bash
# Export portable proof bundle and verify trustlessly with ONLY an EVM RPC URL
curl -s http://127.0.0.1:3001/v1/public/passports/<PUBLIC_ID>/proof-bundle -o bundle.json
pnpm verify:bundle -- --file bundle.json --rpc http://127.0.0.1:8545

# Trigger isolated before/after tamper demonstration
pnpm demo:tamper -- --batch <BATCH_UUID> --public <PUBLIC_ID> --mode db --seq 2
```

---

## Option C — Running Against Base Sepolia

- **Deployed `TraceB3Ledger` (Base Sepolia, `chainId: 84532`):** [`0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1`](https://sepolia.basescan.org/address/0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1)

Set in `.env`:
- `CHAIN_RPC_URL=<Base Sepolia RPC URL>`
- `CHAIN_ID=84532`
- `LEDGER_ADDRESS=0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1`
- `RELAYER_PRIVATE_KEY=<Funded Base Sepolia Relayer Key>`
- `DEMO_MODE=true`
- `PUBLIC_VIEW_LEVEL=full`

Start the API (`pnpm dev:api`), seed onto Base Sepolia (`pnpm demo:seed`), and run `pnpm demo:e2e`. The script outputs clickable `https://sepolia.basescan.org/tx/...` links for every custody event.

### Verified Base Sepolia E2E Run (`TB3-DEMO-1795249516071`, Public ID `2TcxO0San0f5KioL`)

| Seq | Event Type | Block | Transaction |
| :--- | :--- | :--- | :--- |
| `#1` | `CREATED` | `61638238` | [`0x9a345df3...e9a4a4`](https://sepolia.basescan.org/tx/0x9a345df3d2fb6fd00ad9396196b15d683b93b93e338f984d98762ac514e9a4a4) |
| `#2` | `CUSTODY_TRANSFERRED` | `61638268` | [`0xb560310f...49fec0d`](https://sepolia.basescan.org/tx/0xb560310ff72c1ba9eaf87b8de7355167c23e76ea04cf52dee8edd1bc249fec0d) |
| `#3` | `CUSTODY_TRANSFERRED` | `61638295` | [`0x9a8a2b79...f99346f`](https://sepolia.basescan.org/tx/0x9a8a2b793f22d41ff5b26b94c2f4584345aa14ec17a47661854e985bcf99346f) |
| `#4` | `REVISION` | `61638304` | [`0xae7d1ede...e8886b`](https://sepolia.basescan.org/tx/0xae7d1edeb3f2ad084cd8cd57298a73157573cb564467e26c8dc8037578e8886b) |
| `#5` | `TREATMENT` | `61638313` | [`0xd1c06aeb...7141d98`](https://sepolia.basescan.org/tx/0xd1c06aeb4b4384323802d337f027340d9b027cc325b7d46127cbdcd837141d98) |
