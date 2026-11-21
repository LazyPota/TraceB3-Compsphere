# TRACEB3 Frontend Deployment Runbook (`apps/web`)

This 5-minute runbook prepares `apps/web` (Next.js 16 App Router + `wagmi` v3 + Tailwind v4) for hackathon stage demos on **Vercel** or a **standalone Docker container**, connected to `apps/api` and **Base Sepolia**.

- **Deployed Contract (`TraceB3Ledger`, Base Sepolia `chainId: 84532`):**
  `0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1`

---

## 1. Vercel Deployment (Recommended, ~3 Minutes)

1. Import the `TraceB3-Compsphere` repository in Vercel.
2. In **Project Settings → Build & Deployment**, set **Root Directory** to `apps/web`.
3. `apps/web/vercel.json` is preconfigured with:
   - Install Command: `pnpm install --frozen-lockfile`
   - Build Command: `pnpm --filter @traceb3/core build && pnpm --filter @traceb3/contracts build && pnpm --filter web build`
   - Security & camera headers (`Permissions-Policy: camera=(self)` so QR scanning works in mobile browsers over HTTPS).
4. Set these **Environment Variables** in Vercel (all public `NEXT_PUBLIC_*` values — never place private keys here):
   ```text
   NEXT_PUBLIC_API_URL=https://<your-deployed-api-domain>
   NEXT_PUBLIC_PUBLIC_APP_URL=https://<your-vercel-app>.vercel.app
   NEXT_PUBLIC_CHAIN_ID=84532
   NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
   NEXT_PUBLIC_DEMO_MODE=true
   ```
   *(Set `NEXT_PUBLIC_DEMO_MODE=false` after the hackathon pitch to hide the floating Demo Controls drawer.)*

---

## 2. Docker Standalone Fallback

Build from the **monorepo root** so workspace packages (`@traceb3/core`, `@traceb3/contracts`) are included cleanly:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://<your-api-domain> \
  --build-arg NEXT_PUBLIC_PUBLIC_APP_URL=https://<your-web-domain> \
  --build-arg NEXT_PUBLIC_CHAIN_ID=84532 \
  --build-arg NEXT_PUBLIC_RPC_URL=https://sepolia.base.org \
  --build-arg NEXT_PUBLIC_DEMO_MODE=true \
  -t traceb3-web .

docker run -p 3000:3000 traceb3-web
```

---

## 3. Hosting & Wiring the Hono API (`apps/api`)

A public Vercel frontend cannot reach `localhost:3001`. For a public stage pitch:
- Deploy root `Dockerfile` on **Render**, **Fly.io**, or **Railway** backed by Supabase PostgreSQL + Storage (or run locally behind an HTTPS tunnel for live pitch demos).
- Update these **exact** environment variables in `apps/api` to match your deployed frontend domain:
  ```text
  FRONTEND_ORIGINS=https://<your-vercel-app>.vercel.app,http://localhost:3000
  SIWE_DOMAIN=<your-vercel-app>.vercel.app
  PUBLIC_APP_URL=https://<your-vercel-app>.vercel.app
  PUBLIC_VIEW_LEVEL=full
  DEMO_MODE=true
  ```
  - **`SIWE_DOMAIN` must equal the exact frontend hostname** (no `https://`), or `POST /v1/auth/verify` will reject SIWE messages with a domain mismatch.
  - **`PUBLIC_APP_URL` sets the URL encoded inside generated QR labels** (`${PUBLIC_APP_URL}/p/${publicId}`).
  - Set `DEMO_MODE=false` when deploying outside hackathon demos.

---

## 4. 60-Second Pre-Pitch Smoke Checklist

1. **SIWE Auth (`/connect`):** Connect MetaMask with an authorized demo wallet (`$0` ETH required — all custody txs are gas-sponsored), switch to **Base Sepolia (84532)**, sign EIP-4361 message, confirm role badge.
2. **Create & Print (`/batches/new`):** As `GENERATOR`, enter weight (`850 kg`), confirm unit checkbox, attach evidence photo + manifest PDF, sign EIP-712 prompt -> verify `ANCHORED` link on BaseScan and preview A6 QR print label.
3. **Mobile QR Handoff & Discrepancy (`/scan` → `/handoff/[id]`):** Switch to `TRANSPORTER`, pickup `850 kg`; switch to `FACILITY`, log `620 kg` -> watch live `-230 kg (-27.06%)` critical warning appear before signing.
4. **Append-Only Revision (`/batches/[id]/revise`):** Revise seq #3 to `845 kg` (`SCALE_RECALIBRATION`) -> original #3 remains preserved while discrepancy clears.
5. **Live Tamper Detection (Demo Controls Drawer or `/audit`):** Click `Simulate DB Row Tamper` -> refresh `/p/[publicId]` or `/audit` and verify the crimson **`INTEGRITY BREACH — TAMPERED`** banner (`HASH_MISMATCH`) fires immediately.
