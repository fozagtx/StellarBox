<p align="center">
  <img src="assets/logo.svg" width="120" alt="StellaBox logo">
</p>

<h1 align="center">StellaBox</h1>

**A non-custodial Stellar smart-account wallet where AI agents pay inside on-chain spending limits — passkey login, sponsored fees, revoke anytime.**

<p align="center">
  <a href="https://stellar.org"><img src="https://img.shields.io/badge/Stellar-Soroban-7D00FF?logo=stellar&logoColor=white" alt="Stellar"></a>
  <img src="https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white" alt="Next.js">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS">
  <img src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/PostgreSQL-4169B1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Drizzle_ORM-C5F74F?logo=drizzle&logoColor=black" alt="Drizzle ORM">
  <img src="https://img.shields.io/badge/Rust-Soroban-DEA584?logo=rust&logoColor=black" alt="Rust / Soroban">
  <img src="https://img.shields.io/badge/MCP-Server-8B5CF6?logoColor=white" alt="MCP">
  <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

<p align="center">
  <img src="https://cdn.simpleicons.org/stellar/7D00FF" height="18" alt="Stellar icon"> &nbsp;Built on <b>Stellar</b> smart accounts · <b>Testnet only</b> — every balance is test USDC and test XLM
</p>

|                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [How it works](#how-it-works) · [Architecture](#architecture) · [Tech stack](#tech-stack) · [Requirements](#requirements) · [Quickstart](#quickstart) · [MCP tools](#mcp-tools) · [Deploy](#deploy-to-render) · [Repository layout](#repository-layout) · [Checks](#checks) · [Troubleshooting](#troubleshooting) |

## How it works

1. **Create a wallet.** The browser creates a P-256 passkey and deploys an OpenZeppelin smart account whose admin signer is that passkey. OpenZeppelin Channels relays the deployment, so fees are sponsored. The passkey prompt doubles as sign-in — you see one prompt.
2. **Fund it.** Tap **Get test USDC** on the Deposit page: the API funds a throwaway account with Friendbot, swaps XLM for Circle testnet USDC, and transfers it into the wallet (Circle's faucet only reaches `G…` accounts, not the wallet's `C…` contract address).
3. **Grant an agent.** A grant adds a context rule on-chain: an Ed25519 agent signer, OpenZeppelin's spending-limit policy (daily cap), and this repo's `tx-max-policy` contract (per-transaction cap). You sign the rule with your passkey; the API stores the agent key encrypted under `KEYSTORE_MASTER_KEY`.
4. **The agent pays.** An MCP client authorizes with OAuth against one grant, then calls `send_payment` or `pay_x402`. The agent key signs the authorization, the policies check it on-chain, and Channels submits it.
5. **Approve the rest.** Anything outside the grant goes through `request_approval`; you approve or reject in the app (with optional web push), confirming with your passkey.
6. **Revoke anytime.** Revoking a grant removes its context rule on-chain.

## Architecture

**Components** — browser, API, data, and the on-chain enforcement layer:

```mermaid
flowchart TB
    subgraph BROWSER["Browser"]
        W["apps/web · Next.js 15<br/>passkey onboarding · dashboard · grants · approvals"]
    end

    subgraph CLIENTS["Agent clients"]
        M["MCP client<br/>OAuth 2.1 · scoped to one grant"]
    end

    subgraph API["apps/api · Express :4000"]
        AUTH["Passkey auth & sessions"]
        GR["Grants · approvals · /relay fee sponsor"]
        MC["MCP server at /mcp<br/>send_payment · pay_x402 · request_approval"]
        KS["Keystore · packages/signer<br/>Ed25519 agent keys, encrypted"]
    end

    subgraph DATA["Data"]
        DB[("PostgreSQL<br/>packages/db · Drizzle")]
    end

    subgraph CHAIN["Stellar testnet"]
        SA["OpenZeppelin smart account<br/>C… contract address"]
        WL["WebAuthn verifier<br/>P-256 passkey rule"]
        POL["Spending-limit policy<br/>daily cap"]
        TX["tx-max-policy<br/>per-transaction cap"]
        CH["OpenZeppelin Channels<br/>fee-sponsored relay"]
        USDC["USDC · Soroban token"]
    end

    P["apps/paid-api :4100<br/>x402 demo: /search · /weather"]

    W -->|"HTTPS · session cookie"| AUTH
    W -->|approve with passkey| GR
    M -->|"OAuth + MCP tools"| MC
    GR --> DB
    KS --> DB
    MC -->|sign with agent key| CH
    CH -->|submit authorization| SA
    SA --- WL
    SA --- POL
    SA --- TX
    SA -->|Soroban transfer| USDC
    MC -->|pay_x402| P
```

**A payment** — every transfer is checked on-chain, so a compromised server still can't overspend:

```mermaid
sequenceDiagram
    autonumber
    actor U as User (passkey)
    participant W as apps/web
    participant A as apps/api
    participant M as MCP client (agent)
    participant C as Channels relay
    participant S as Smart account (Stellar)

    U->>W: Create wallet (passkey) · grant agent
    W->>A: Register wallet + signed context rule
    A->>C: Relay deployment (fees sponsored)
    C->>S: Deploy account with grant rules

    M->>A: OAuth (one grant) → send_payment
    A->>C: Signed authorization (agent key)
    C->>S: Submit Soroban transfer
    S->>S: __check_auth → passkey rule · daily cap · tx cap
    alt within the grant
        S-->>M: USDC payment settled
    else outside the grant
        S--xA: Rejected by policy
        A->>W: request_approval → you confirm with passkey
    end
```

## Tech stack

| Layer | What it is |
| --- | --- |
| **Chain** | <img src="https://cdn.simpleicons.org/stellar/7D00FF" height="14" alt="Stellar"> Stellar (Soroban) · OpenZeppelin smart accounts & Channels · Rust `tx-max-policy` contract · `@stellar/stellar-sdk` |
| **Web** | Next.js 15 · React 19 · Tailwind CSS 4 · SimpleWebAuthn (P-256 passkeys) |
| **API** | Express 5 · Zod · OAuth 2.1 + MCP server · web-push (VAPID) · x402 |
| **Data** | PostgreSQL · Drizzle ORM · encrypted Ed25519 keystore (`packages/signer`) |
| **Tooling** | pnpm workspaces · TypeScript 5 · Vitest · Docker Compose · Render Blueprint |

## Requirements

- **Node.js 24** and **pnpm 11**
- **Docker** (for the local PostgreSQL)
- **OpenZeppelin Channels API key** (free testnet key, [channels.openzeppelin.com/testnet/gen](https://channels.openzeppelin.com/testnet/gen))
- **Rust** only to test the policy contract

## Quickstart

```bash
git clone https://github.com/fozagtx/StellarBox && cd StellarBox
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp .env.example .env                       # then fill it in (see below)
pnpm --filter @stellabox/db db:migrate
pnpm --filter @stellabox/api start         # http://localhost:4000
pnpm --filter @stellabox/web dev           # http://localhost:3000
pnpm --filter @stellabox/paid-api start    # http://localhost:4100 (optional)
```

For local Docker, set `DATABASE_URL=postgres://stellabox:stellabox@localhost:5433/stellabox` (the value in `.env.example` assumes a natively installed PostgreSQL on 5432). Passkeys work on `localhost` over plain HTTP; on any other host they need HTTPS.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Any PostgreSQL connection string |
| `SESSION_SECRET` | yes | Long random string. Signs session cookies and registration challenges |
| `KEYSTORE_MASTER_KEY` | yes | Encrypts agent keys. Generate with `openssl rand -base64 32` |
| `CHANNELS_API_KEY` | yes | Free testnet key from [OpenZeppelin Channels](https://channels.openzeppelin.com/testnet/gen). Without it, wallet creation and every sponsored transaction fail |
| `PUBLIC_WEB_URL` | yes, outside Render | Origin of the web app. Must match the browser origin exactly — passkeys are bound to it |
| `PUBLIC_API_URL` | yes, outside Render | Public origin of the API, used for OAuth and MCP metadata |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Web push for approvals. Generate with `npx web-push generate-vapid-keys` |
| `STELLAR_*`, contract addresses | optional | Override values from `deployments/testnet.json` |

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

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/fozagtx/StellarBox)

Use the Blueprint in `render.yaml`. It creates three services — `stellabox-api`, `stellabox-paid-api`, `stellabox-web` — generates `SESSION_SECRET` and `KEYSTORE_MASTER_KEY`, and wires `WEB_HOST`/`API_HOST` between them. Migrations run when the API starts. Fill in:

- `DATABASE_URL` on `stellabox-api`: any PostgreSQL connection string (Render, Neon, Supabase). Render allows one free database per workspace, so the Blueprint doesn't create one.
- `CHANNELS_API_KEY` on `stellabox-api`: get a key from [channels.openzeppelin.com/testnet/gen](https://channels.openzeppelin.com/testnet/gen).
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (optional): approval push notifications.
- `PAID_API_FACILITATOR_SECRET` on `stellabox-paid-api` (optional): a funded testnet secret key for x402 settlement. Left blank, the service creates a key, funds it with Friendbot, and logs only its public address.

The paid API pays out to the merchant account in `deployments/testnet.json`. Set `PAID_API_MERCHANT_ADDRESS` only for a different merchant account with a USDC trustline. After deploying, `https://<api-host>/health` should return `{"ok":true,"channelsConfigured":true,...}`.

## Repository layout

```
apps/web                 Next.js app: landing, passkey onboarding, dashboard, grants, approvals, OAuth screen
                         (proxies /api/* so session cookies stay same-origin)
apps/api                 Express API :4000 — passkey auth, wallet registration, /relay sponsor, grants,
                         approvals, OAuth, MCP server at /mcp
apps/paid-api            x402 demo service :4100 — GET /search ($0.01), GET /weather ($0.02)
packages/db              Drizzle schema, SQL migrations, repositories (PostgreSQL)
packages/signer          Encrypted keystore for agent Ed25519 keys
packages/stellar         Stellar config, Channels client, grant rule builders, testnet cap proof
contracts/tx-max-policy  Soroban policy contract capping any single transfer (Rust)
deployments/testnet.json Deployed testnet contract addresses and account WASM hash
scripts/                 End-to-end checks against testnet (e2e-api, e2e-web, prove-caps)
evidence/                Recorded output from those testnet runs
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test                                        # API tests need the Docker PostgreSQL on :5433
cargo test -p tx-max-policy
pnpm e2e:api                                     # end-to-end against testnet (needs a filled .env)
pnpm --filter @stellabox/stellar prove:testnet   # on-chain cap proof
```

## Troubleshooting

**"Fee sponsoring is not configured: set CHANNELS_API_KEY on the stellabox-api service."**
The API has no Channels key, so it can't sponsor the wallet deployment. Get a key from the [`/gen` endpoint](https://channels.openzeppelin.com/testnet/gen). In Render, open **stellabox-api → Environment**, add `CHANNELS_API_KEY`, and save (this redeploys). Confirm with `/health` (`channelsConfigured: true`).

**`GET /api/auth/session 401` in the console on the onboarding page.**
Expected before you sign in — the page checks for an existing session on load.

**`publicKey.pubKeyCredParams is missing ... ES256 and RS256` warning.**
Expected. The on-chain WebAuthn verifier only supports P-256 (ES256), so the app requests only that algorithm. Every platform authenticator supports it.

**I used Circle's faucet but the wallet shows 0 USDC.**
Circle's faucet sends classic Stellar payments, which can't reach a smart account's `C…` address. Use **Get test USDC** on the Deposit page instead. To send from another wallet, use one that supports Soroban token transfers to contract addresses.

**`pay_x402` fails with `invalid_exact_stellar_payload_fee_exceeds_maximum`.**
The endpoint's x402 facilitator caps transaction fees below what a smart-account payment costs — every payment runs the account's `__check_auth` (passkey verifier + both spending policies), so its Soroban fee is higher than a plain ed25519 payment's. Facilitators such as `x402.org` reject it, and no USDC is spent. StellaBox's own paid API allows up to 0.2 XLM in fees and accepts these payments; for your own x402 endpoint, raise its facilitator's maximum fee the same way.

**The passkey prompt was cancelled or timed out.**
Tap the button again and finish the prompt. If wallet creation succeeded but sign-in didn't finish, use **Sign in with passkey** — the browser remembers the credential.

**"No StellaBox passkey is saved in this browser yet."**
Sign-in looks up the credential saved by this browser at wallet creation. Use the browser that created the wallet, or create a new wallet.
