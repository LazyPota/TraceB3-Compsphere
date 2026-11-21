# TRACEB3 Frontend Deployment Runbook (`apps/web`)

This 5-minute runbook prepares `apps/web` (Next.js 16 App Router + `wagmi` v3 + Tailwind v4) for hackathon stage demos on **Vercel** or a **standalone Docker container**, connected to `apps/api` and **Base Sepolia**.

- **Deployed Contract (`TraceB3Ledger`, Base Sepolia `chainId: 84532`):**
  `0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1`

---

## 1. All-in-One Vercel Hobby + Supabase Deployment (\$0, No Credit Card)

`apps/web` embeds the Hono API (`@traceb3/api`) at `/api/[[...route]]` (`Node.js` runtime), so a **single Vercel Hobby project** serves both the Next.js frontend and backend API against **Supabase PostgreSQL + Storage** and **Base Sepolia** with zero external container hosting or payment method required.

1. Apply database migrations once against Supabase before deploying:
   ```powershell
   pnpm --filter @traceb3/api db:migrate
   ```
2. Push your latest `main` branch and import `TraceB3-Compsphere` in Vercel.
3. In **Project Settings → Build & Deployment**, set **Root Directory** to `apps/web` and **Node.js Version** to `22.x`.
   - `apps/web/vercel.json` preconfigures:
     - Install Command: `pnpm install --frozen-lockfile`
     - Build Command: `pnpm --filter @traceb3/core build && pnpm --filter @traceb3/contracts build && pnpm --filter @traceb3/api build && pnpm --filter web build`
     - Security & camera headers (`Permissions-Policy: camera=(self)` so mobile QR scanning works over HTTPS).
4. Set **Environment Variables** in Vercel:
   - **Public frontend vars:**
     ```text
     NEXT_PUBLIC_API_URL=/api
     NEXT_PUBLIC_PUBLIC_APP_URL=https://<your-vercel-app-or-xyz-domain>
     NEXT_PUBLIC_CHAIN_ID=84532
     NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
     NEXT_PUBLIC_DEMO_MODE=true
     ```
   - **Server-only API vars (never prefix with `NEXT_PUBLIC_`):**
     ```text
     NODE_ENV=production
     DATABASE_URL=<supabase-pooler-postgresql-url-with-sslmode-require>
     STORAGE_DRIVER=supabase
     SUPABASE_URL=https://<project-ref>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>
     SUPABASE_STORAGE_BUCKET=traceb3-evidence
     CHAIN_RPC_URL=<base-sepolia-rpc-url>
     CHAIN_ID=84532
     LEDGER_ADDRESS=0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1
     RELAYER_PRIVATE_KEY=<base-sepolia-relayer-private-key>
     JWT_SECRET=<32+-char-random-secret>
     PUBLIC_VIEW_LEVEL=full
     DEMO_MODE=true
     ```
     *(When `SIWE_DOMAIN`, `PUBLIC_APP_URL`, `API_PUBLIC_URL`, and `FRONTEND_ORIGINS` are omitted on Vercel, `apps/web/src/lib/server-api.ts` automatically derives them from `NEXT_PUBLIC_PUBLIC_APP_URL` / `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`. Set explicit values if you use a custom domain such as `<yourdomain>.xyz`.)*
5. **Custom `.xyz` Domain:** Add `<yourdomain>.xyz` in **Vercel → Settings → Domains**, update `NEXT_PUBLIC_PUBLIC_APP_URL` (and `SIWE_DOMAIN=<yourdomain>.xyz` if set explicitly), then **Redeploy** so `NEXT_PUBLIC_*` build-time constants update.
6. **Hobby Upload Limit:** Vercel serverless functions cap request bodies at **4.5 MB**; keep uploaded demo photos/PDFs under ~4 MB. Set `NEXT_PUBLIC_DEMO_MODE=false` and `DEMO_MODE=false` after the hackathon pitch.

---

## 2. Separate API Host Alternative (Docker Fallback)

If you prefer hosting `apps/api` on its own persistent container (e.g., Render, Fly.io, Railway, or VPS) alongside Docker standalone frontend:

- Build the standalone frontend from the **monorepo root**:

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

- Point Vercel's `NEXT_PUBLIC_API_URL=https://<your-deployed-api-domain>` and set on the API host:
  ```text
  FRONTEND_ORIGINS=https://<your-vercel-app>.vercel.app,http://localhost:3000
  SIWE_DOMAIN=<your-vercel-app>.vercel.app
  PUBLIC_APP_URL=https://<your-vercel-app>.vercel.app
  PUBLIC_VIEW_LEVEL=full
  DEMO_MODE=true
  ```
  - **`SIWE_DOMAIN` must equal the exact frontend hostname** (no `https://`), or `POST /v1/auth/verify` rejects SIWE logins with a domain mismatch.
  - **`PUBLIC_APP_URL` sets the URL encoded inside generated QR labels** (`${PUBLIC_APP_URL}/p/${publicId}`).

---

## 4. 60-Second Pre-Pitch Smoke Checklist

1. **SIWE Auth (`/connect`):** Connect MetaMask with an authorized demo wallet (`$0` ETH required — all custody txs are gas-sponsored), switch to **Base Sepolia (84532)**, sign EIP-4361 message, confirm role badge.
2. **Create & Print (`/batches/new`):** As `GENERATOR`, enter weight (`850 kg`), confirm unit checkbox, attach evidence photo + manifest PDF, sign EIP-712 prompt -> verify `ANCHORED` link on BaseScan and preview A6 QR print label.
3. **Mobile QR Handoff & Discrepancy (`/scan` → `/handoff/[id]`):** Switch to `TRANSPORTER`, pickup `850 kg`; switch to `FACILITY`, log `620 kg` -> watch live `-230 kg (-27.06%)` critical warning appear before signing.
4. **Append-Only Revision (`/batches/[id]/revise`):** Revise seq #3 to `845 kg` (`SCALE_RECALIBRATION`) -> original #3 remains preserved while discrepancy clears.
5. **Live Tamper Detection (Demo Controls Drawer or `/audit`):** Click `Simulate DB Row Tamper` -> refresh `/p/[publicId]` or `/audit` and verify the crimson **`INTEGRITY BREACH — TAMPERED`** banner (`HASH_MISMATCH`) fires immediately.
