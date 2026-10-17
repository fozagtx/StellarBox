# StellaBox

StellaBox is a non-custodial Stellar smart-account wallet that lets AI agents make payments within user-defined, on-chain spending limits.

## Deploy to Render

[Deploy StellaBox to Render](https://render.com/deploy?repo=https://github.com/fozagtx/StellarBox) with the Blueprint. It creates the API, paid API, and web app. Paste any PostgreSQL connection string (Render, Neon, Supabase) as `DATABASE_URL` on the API service; Render allows only one free database per workspace, so the Blueprint doesn't create one. The API migrations run when the service starts. Render generates the session and keystore secrets automatically.

Fill in these Blueprint values:

- `CHANNELS_API_KEY`: a free Stellar testnet key from OpenZeppelin Channels' [`/gen` endpoint](https://channels.openzeppelin.com/testnet/gen).
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: generate them with `npx web-push generate-vapid-keys`.
- `PAID_API_FACILITATOR_SECRET` (optional): a funded Stellar testnet secret key for x402 settlement. Leave it blank to have the paid API create a key, fund it with Friendbot, and log only its public address.

The paid API uses the public merchant account in `deployments/testnet.json`; set `PAID_API_MERCHANT_ADDRESS` only if you have configured a different merchant account with a USDC trustline. The web app proxies browser API requests through `/api`, keeping session cookies same-origin, and publishes the API's `/mcp` URL for clients.
