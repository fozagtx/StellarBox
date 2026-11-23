<p align="center">
  <img src="./assets/logo.svg" alt="StellaBox logo" width="120"/>
</p>

<h1 align="center">StellaBox</h1>

<p align="center">
  <strong>Smart-account wallet on Stellar where AI agents pay inside on-chain spending limits: passkey login, sponsored fees, revoke anytime</strong>
</p>

<p align="center">
  <a href="https://github.com/fozagtx/StellarBox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fozagtx/StellarBox/ci.yml?branch=main&label=CI" alt="CI"/></a>
  <a href="https://github.com/fozagtx/StellarBox/actions/workflows/contracts.yml"><img src="https://img.shields.io/github/actions/workflow/status/fozagtx/StellarBox/contracts.yml?branch=main&label=Contracts%20CI" alt="Contracts CI"/></a>
  <img src="https://img.shields.io/badge/network-Stellar%20testnet-7D00FF?logo=stellar&logoColor=white" alt="Stellar testnet"/>
  <img src="https://img.shields.io/badge/Soroban-Rust-DEA584?logo=rust&logoColor=black" alt="Soroban"/>
  <img src="https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white" alt="Next.js"/>
  <img src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" alt="Express"/>
  <img src="https://img.shields.io/badge/PostgreSQL-Drizzle-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/MCP-server-8B5CF6" alt="MCP"/>
  <img src="https://img.shields.io/badge/deploy-Vercel-000000?logo=vercel&logoColor=white" alt="Vercel"/>
</p>

<p align="center">
  <a href="https://stellabox-web.vercel.app">Live app</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#mcp-tools">MCP tools</a> •
  <a href="#deploy">Deploy</a> •
  <a href="https://github.com/fozagtx/StellarBox/issues">Issues</a>
</p>

---

## What is StellaBox?

StellaBox is a **non-custodial wallet for handing AI agents a budget**. Your wallet is an OpenZeppelin smart account on Stellar whose admin is a passkey on your device. You grant an agent a scoped key, and the limits on that key (a daily cap and a per-transaction cap) are enforced by Soroban policy contracts in the account's `__check_auth`, not by the server. An agent connects over MCP, pays in USDC or settles x402 requests, and asks you for approval for anything outside its grant. Every balance is test USDC and test XLM: StellaBox runs on **testnet only**.

**Core Features:**
- **Passkey smart account**: one P-256 passkey prompt creates the wallet and signs you in. No seed phrase, no browser extension
- **On-chain agent limits**: each grant is a context rule with an Ed25519 agent signer, OpenZeppelin's spending-limit policy (daily cap) and this repo's `tx-max-policy` (per-transaction cap)
- **Sponsored fees**: OpenZeppelin Channels pays network fees for deployments and payments, so the wallet never needs XLM for gas
- **MCP server**: OAuth 2.1 scoped to one grant, with `send_payment`, `pay_x402`, `request_approval` and balance/activity tools
- **Approvals and revocation**: out-of-grant requests reach you in the app (optional web push) and are confirmed with your passkey. Revoking removes the rule on-chain

## Status

| Component | Status | Notes |
|-----------|--------|-------|
| Passkey wallet creation | ✅ Working | P-256 WebAuthn verifier; deployment relayed through Channels |
| Fee sponsorship | ✅ Working | `/relay` checks the session and wallet ownership before Channels submits |
| Agent grants (daily + per-tx caps) | ✅ Working | Enforced on-chain; recorded proof in `evidence/prove-caps-testnet.json` |
| `tx-max-policy` contract | ✅ Working | Rust unit tests cover under/over cap, negative amounts, disallowed functions |
| MCP server + OAuth 2.1 | ✅ Working | Stateless Streamable HTTP; one token is bound to one grant |
| x402 payments | ✅ Working | Against the bundled paid API; see the facilitator fee note in Troubleshooting |
| Approvals + web push | ✅ Working | Push needs VAPID keys |
| Test USDC faucet | ✅ Working | Friendbot → XLM/USDC swap → SAC transfer into the `C…` account, once an hour |
| Vercel deployment | ✅ Working | API as one serverless function, web as Next.js; see [Deploy](#deploy) |
| Mainnet | ⛔ Not supported | The network is pinned to testnet in `packages/stellar/src/config.ts` |

### Known limitations (testnet)

- **Agent keys live on the server.** They're encrypted under `KEYSTORE_MASTER_KEY`, and the on-chain caps bound what a leaked key can spend, but the server can sign anything within a grant.
- **Sponsorship limits are coarse.** Wallet deploys are limited to 5 a minute per IP; signed-in relays rely on the ownership check alone, with no per-user quota yet.
- **The x402 demo API is not on Vercel.** `apps/paid-api` runs locally or on any Node host. `pay_x402` works with any HTTPS x402 endpoint.

## How it works

1. **Create a wallet.** The browser creates a passkey and deploys a smart account whose admin signer is that passkey. Channels relays the deployment, so fees are sponsored.
2. **Fund it.** **Get test USDC** on the Deposit page funds a throwaway account with Friendbot, swaps XLM for Circle testnet USDC and transfers it into the wallet. Circle's faucet only reaches `G…` accounts, not the wallet's `C…` address.
3. **Grant an agent.** You sign a context rule with your passkey. The API stores the agent key encrypted.
4. **The agent pays.** An MCP client authorizes against one grant and calls `send_payment` or `pay_x402`. The agent key signs, the policies check it on-chain, and Channels submits it.
5. **Approve the rest.** Anything outside the grant goes through `request_approval`, which you approve or reject with your passkey.
6. **Revoke anytime.** Revoking a grant removes its context rule on-chain.

## Architecture

**Components**: browser, API, data, and the on-chain enforcement layer:

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

**A payment**: every transfer is checked on-chain, so a compromised server still can't overspend:

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

## Quick Start

Requires **Node.js 24**, **pnpm 11**, **Docker** (local PostgreSQL), a free **[OpenZeppelin Channels testnet key](https://channels.openzeppelin.com/testnet/gen)**, and **Rust** only for the policy contract.

```bash
git clone https://github.com/fozagtx/StellarBox && cd StellarBox
pnpm install
docker compose up -d                       # PostgreSQL on localhost:5433
cp .env.example .env                       # fill it in (see below)
pnpm --filter @stellabox/db db:migrate
pnpm --filter @stellabox/api start         # http://localhost:4000
pnpm --filter @stellabox/web dev           # http://localhost:3000
pnpm --filter @stellabox/paid-api start    # http://localhost:4100 (optional x402 demo)
```

For local Docker, set `DATABASE_URL=postgres://stellabox:stellabox@localhost:5433/stellabox`. Passkeys work on `localhost` over plain HTTP; any other host needs HTTPS.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Any PostgreSQL connection string (use a pooled one on serverless) |
| `SESSION_SECRET` | yes | Long random string. Signs session cookies and registration challenges |
| `KEYSTORE_MASTER_KEY` | yes | Encrypts agent keys. `openssl rand -base64 32` |
| `CHANNELS_API_KEY` | yes | Without it, wallet creation and every sponsored transaction fail |
| `PUBLIC_WEB_URL` | yes, when deployed | Web app origin. Passkeys are bound to it, so it must match exactly |
| `PUBLIC_API_URL` | yes, when deployed | Public API origin, used for OAuth and MCP metadata |
| `API_HOST` | web only | API hostname; the web app proxies `/api/*` to it so cookies stay same-origin |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Web push for approvals. `npx web-push generate-vapid-keys` |
| `STELLAR_*`, contract addresses | optional | Override values from `deployments/testnet.json` |

## Project Structure

```
StellarBox/
├── apps/
│   ├── web/              # Next.js: landing, passkey onboarding, dashboard, grants, approvals, OAuth screen
│   ├── api/              # Express: passkey auth, /relay sponsor, grants, approvals, OAuth, MCP at /mcp
│   │   └── api/index.js  # Vercel serverless entry (bundled from src/vercel.ts)
│   └── paid-api/         # x402 demo service: GET /search ($0.01), GET /weather ($0.02)
├── packages/
│   ├── db/               # Drizzle schema, SQL migrations, repositories
│   ├── signer/           # Encrypted keystore for agent Ed25519 keys
│   └── stellar/          # Network config, Channels client, grant rule builders, funding
├── contracts/
│   └── tx-max-policy/    # Soroban policy capping any single transfer (Rust)
├── deployments/          # Testnet contract addresses and account WASM hash
├── scripts/              # End-to-end checks against testnet
└── evidence/             # Recorded output from those testnet runs
```

## MCP tools

Connect an MCP client to `https://stellabox-api.vercel.app/mcp` (or `<API URL>/mcp`). The client goes through OAuth, and you pick or create the grant it may use.

| Tool | Purpose |
| --- | --- |
| `get_balance` | Live USDC/XLM balances and remaining grant budget |
| `list_grants` | The grant bound to the token |
| `send_payment` | Send USDC within the grant's on-chain limits |
| `pay_x402` | Pay a Stellar testnet x402 endpoint within the grant's limits |
| `request_approval` / `get_approval` | Ask the owner to approve an action and check its status |
| `get_activity` | Recent actions for the grant |

## Deploy

### Vercel

StellaBox deploys as two Vercel projects from this one repo:

| Project | Root directory | What it runs |
| --- | --- | --- |
| `stellabox-api` | `apps/api` | Migrations at build, then the Express app as one function (`apps/api/vercel.json`) |
| `stellabox-web` | `apps/web` | Next.js, proxying `/api/*` to `API_HOST` |

1. Create a PostgreSQL database (Neon works well; use its **pooled** connection string).
2. Create both projects with the root directories above and Node 24.
3. On `stellabox-api`, set `DATABASE_URL`, `CHANNELS_API_KEY`, `SESSION_SECRET`, `KEYSTORE_MASTER_KEY`, `PUBLIC_WEB_URL` and `PUBLIC_API_URL`. On `stellabox-web`, set `API_HOST`.
4. Deploy the API first, then the web app. `https://<api-host>/health` should return `{"ok":true,"channelsConfigured":true,...}`.

The faucet keeps its job state in Postgres and uses `waitUntil`, so funding finishes after the response and any instance can answer the poll. The API function allows up to 120 s.

### Other hosts

`render.yaml` is a Render Blueprint for the same three services. Any Node host works: build with `pnpm install`, run `pnpm --filter @stellabox/db db:migrate`, then `pnpm --filter @stellabox/api start`.

## Contributing

```bash
# Before opening a PR
pnpm typecheck
pnpm lint
pnpm test                                        # API tests need the Docker PostgreSQL on :5433
cargo test -p tx-max-policy
pnpm e2e:api                                     # end to end against testnet (needs a filled .env)
pnpm --filter @stellabox/stellar prove:testnet   # on-chain cap proof
```

## Troubleshooting

**"Fee sponsoring is not configured: set CHANNELS_API_KEY on the stellabox-api service."**
The API has no Channels key, so it can't sponsor the wallet deployment. Get a key from the [`/gen` endpoint](https://channels.openzeppelin.com/testnet/gen), add `CHANNELS_API_KEY` to the `stellabox-api` project (Vercel → Settings → Environment Variables), and redeploy. Confirm with `/health` (`channelsConfigured: true`).

**`GET /api/auth/session 401` in the console on the onboarding page.**
Expected before you sign in; the page checks for an existing session on load.

**`publicKey.pubKeyCredParams is missing ... ES256 and RS256` warning.**
Expected. The on-chain WebAuthn verifier only supports P-256 (ES256), so the app requests only that algorithm. Every platform authenticator supports it.

**I used Circle's faucet but the wallet shows 0 USDC.**
Circle's faucet sends classic Stellar payments, which can't reach a smart account's `C…` address. Use **Get test USDC** on the Deposit page instead. To send from another wallet, use one that supports Soroban token transfers to contract addresses.

**`pay_x402` fails with `invalid_exact_stellar_payload_fee_exceeds_maximum`.**
The endpoint's x402 facilitator caps transaction fees below what a smart-account payment costs. Every payment runs the account's `__check_auth` (passkey verifier + both spending policies), so its Soroban fee is higher than a plain ed25519 payment's. Facilitators such as `x402.org` reject it, and no USDC is spent. StellaBox's own paid API allows up to 0.2 XLM in fees and accepts these payments; for your own x402 endpoint, raise its facilitator's maximum fee the same way.

**The passkey prompt was cancelled or timed out.**
Tap the button again and finish the prompt. If wallet creation succeeded but sign-in didn't finish, use **Sign in with passkey**; the browser remembers the credential.

**"No StellaBox passkey is saved in this browser yet."**
Sign-in looks up the credential saved by this browser at wallet creation. Use the browser that created the wallet, or create a new wallet.

---

<p align="center">
  <sub>Built with OpenZeppelin smart accounts, Soroban, and the Model Context Protocol</sub>
</p>
