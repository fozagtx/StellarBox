# StellaBox

StellaBox is a non-custodial Stellar smart-account wallet that lets AI agents make payments within user-defined, on-chain spending limits.

You create the wallet with a passkey. There is no seed phrase, and fees are sponsored. You then give an AI agent a **grant**: a scoped key with a per-transaction cap, a daily cap, and an expiry. The smart account's policies enforce the caps on-chain, so the agent can't spend more than you allowed, even if the StellaBox server is compromised. Agents connect over MCP with OAuth and can pay ordinary addresses or x402-priced HTTP endpoints.

> Testnet only. Every balance is test USDC and test XLM.

## How it works

1. **Create a wallet.** The browser creates a P-256 passkey and deploys an OpenZeppelin smart account whose admin signer is that passkey. OpenZeppelin Channels relays the deployment, so you pay no fees. The passkey's registration response proves you hold it, so creating the wallet also signs you in. You see one passkey prompt.
2. **Fund it.** Send testnet USDC or XLM to the contract address shown on the Deposit page.
3. **Grant an agent.** A grant adds a context rule to the smart account. The rule has an Ed25519 agent signer, the OpenZeppelin spending-limit policy for the daily cap, and the `tx-max-policy` contract in this repo for the per-transaction cap. You sign the rule with your passkey. The API stores the agent key encrypted under `KEYSTORE_MASTER_KEY`.
4. **The agent pays.** An MCP client authorizes with OAuth against one grant, then calls `send_payment` or `pay_x402`. The agent key signs the authorization, the policies check it on-chain, and Channels submits it.
5. **Approvals.** For anything outside the grant, the agent calls `request_approval`. You approve or reject in the app (with optional web push), confirming with your passkey.
6. **Revoke** a grant at any time. Revoking removes its context rule on-chain.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: landing page, passkey onboarding, dashboard, grants, approvals, the OAuth connect screen. It proxies `/api/*` to the API so session cookies stay same-origin. |
| `apps/api` | Express API on port 4000: passkey auth, wallet registration, the `/relay` fee sponsor, grants, approvals, OAuth, and the MCP server at `/mcp`. |
| `apps/paid-api` | A demo x402 service on port 4100: `GET /search` ($0.01 USDC) and `GET /weather` ($0.02 USDC). See [its README](apps/paid-api/README.md). |
| `packages/db` | Drizzle schema, SQL migrations, and repositories (PostgreSQL). |
| `packages/signer` | Encrypted keystore for agent Ed25519 keys. |
| `packages/stellar` | Stellar config, the Channels client, grant rule builders, and the testnet cap proof. |
| `contracts/tx-max-policy` | Soroban policy contract that caps any single transfer. |
| `deployments/testnet.json` | Deployed testnet contract addresses and the account WASM hash. |
| `scripts/` | End-to-end checks against testnet (`e2e-api.ts`, `e2e-web.ts`, `prove-caps.ts`). |
| `evidence/` | Recorded output from those testnet runs. |

## MCP tools

Connect an MCP client to `<API URL>/mcp`. The client goes through OAuth, and you pick or create the grant it may use.

| Tool | Purpose |
| --- | --- |
| `get_balance` | Live USDC/XLM balances and remaining grant budget |
| `list_grants` | The grant bound to the token |
| `send_payment` | Send USDC within the grant's on-chain limits |
| `pay_x402` | Pay a Stellar testnet x402 endpoint within the grant's limits |
| `request_approval` / `get_approval` | Ask the owner to approve an action and check its status |
| `get_activity` | Recent actions for the grant |

## Run locally

Requirements: Node 24, pnpm 11, Docker (for PostgreSQL). Rust is only needed to test the policy contract.

```sh
pnpm install
docker compose up -d          # PostgreSQL on localhost:5433
cp .env.example .env          # then fill it in (see below)
pnpm --filter @stellabox/db db:migrate
pnpm --filter @stellabox/api start      # http://localhost:4000
pnpm --filter @stellabox/web dev        # http://localhost:3000
pnpm --filter @stellabox/paid-api start # http://localhost:4100 (optional)
```

For local Docker, set `DATABASE_URL=postgres://stellabox:stellabox@localhost:5433/stellabox`. The value in `.env.example` uses port 5432 for a natively installed PostgreSQL.

Open `http://localhost:3000`. Passkeys work on `localhost` over plain HTTP. On any other host they need HTTPS.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Any PostgreSQL connection string |
| `SESSION_SECRET` | yes | Long random string. Signs session cookies and registration challenges |
| `KEYSTORE_MASTER_KEY` | yes | Encrypts agent keys. Generate with `openssl rand -base64 32` |
| `CHANNELS_API_KEY` | yes | Free testnet key from [OpenZeppelin Channels](https://channels.openzeppelin.com/testnet/gen). Without it, wallet creation and every sponsored transaction fail |
| `PUBLIC_WEB_URL` | yes, outside Render | Origin of the web app. Must match the browser origin exactly, because passkeys are bound to it |
| `PUBLIC_API_URL` | yes, outside Render | Public origin of the API, used for OAuth and MCP metadata |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Web push for approvals. Generate keys with `npx web-push generate-vapid-keys` |
| `STELLAR_*`, contract addresses | optional | Override values from `deployments/testnet.json` |

## Deploy to Render

[Deploy StellaBox to Render](https://render.com/deploy?repo=https://github.com/fozagtx/StellarBox) with the Blueprint in `render.yaml`. It creates three services: `stellabox-api`, `stellabox-paid-api`, and `stellabox-web`. Render generates `SESSION_SECRET` and `KEYSTORE_MASTER_KEY`, and wires `WEB_HOST`/`API_HOST` between the services. Migrations run when the API starts.

Fill in these values:

- `DATABASE_URL` on `stellabox-api`: any PostgreSQL connection string (Render, Neon, Supabase). Render allows one free database per workspace, so the Blueprint doesn't create one.
- `CHANNELS_API_KEY` on `stellabox-api`: get a key from [channels.openzeppelin.com/testnet/gen](https://channels.openzeppelin.com/testnet/gen).
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (optional): for approval push notifications.
- `PAID_API_FACILITATOR_SECRET` on `stellabox-paid-api` (optional): a funded testnet secret key for x402 settlement. If you leave it blank, the service creates a key, funds it with Friendbot, and logs only its public address.

The paid API pays out to the merchant account in `deployments/testnet.json`. Set `PAID_API_MERCHANT_ADDRESS` only if you use a different merchant account that has a USDC trustline.

After deploying, check `https://<api-host>/health`. It should return `{"ok":true,"channelsConfigured":true,...}`.

## Troubleshooting

**"Fee sponsoring is not configured: set CHANNELS_API_KEY on the stellabox-api service."**
The API has no Channels key, so it can't sponsor the wallet deployment. Get a key from the [`/gen` endpoint](https://channels.openzeppelin.com/testnet/gen). In Render, open **stellabox-api → Environment**, add `CHANNELS_API_KEY`, and save. Saving redeploys the service. Confirm the fix with `/health` (`channelsConfigured: true`).

**`GET /api/auth/session 401` in the console on the onboarding page.**
This is expected before you sign in. The page checks for an existing session on load.

**`publicKey.pubKeyCredParams is missing ... ES256 and RS256` warning.**
This is expected. The on-chain WebAuthn verifier only supports P-256 (ES256), so the app requests only that algorithm. Every platform authenticator supports it.

**The passkey prompt was cancelled or timed out.**
Tap the button again and finish the prompt. If wallet creation succeeded but sign-in didn't finish, use **Sign in with passkey**. The browser remembers the credential.

**"No StellaBox passkey is saved in this browser yet."**
Sign-in looks up the credential saved by this browser at wallet creation. Use the browser that created the wallet, or create a new wallet.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test            # API tests need the Docker PostgreSQL on :5433
cargo test -p tx-max-policy
pnpm e2e:api         # end-to-end against testnet (needs a filled .env)
pnpm --filter @stellabox/stellar prove:testnet   # on-chain cap proof
```
