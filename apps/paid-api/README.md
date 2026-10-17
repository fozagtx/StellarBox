# Paid API

The testnet service listens on port 4100. `GET /search?q=` returns real Wikipedia search results for $0.01 USDC; `GET /weather?lat=&lon=` returns real Open-Meteo data for $0.02 USDC.

## Testnet facilitator

The service uses an in-process `@x402/stellar` facilitator, funded by the testnet fee key in `.deploy/paid-api-facilitator.secret`. Its `MAX_TRANSACTION_FEE_STROOPS` ceiling is 2,000,000 stroops (0.2 XLM). Smart-account payments run the account's `__check_auth`, including the verifier and both spending policies, so their Soroban resource fee can exceed the scheme's 50,000-stroop default.

The OpenZeppelin spending-limit policy emits a contract event during authorization. The local scheme ignores auxiliary non-transfer contract events and delegates transfer-event validation to `@x402/stellar`, which still requires one transfer matching the USDC asset, payer, payee, and amount.

A real testnet trial against `https://x402.org/facilitator` returned `invalid_exact_stellar_payload_fee_exceeds_maximum`. This rejection was about the fee ceiling, not the C-address payer. The trial and the in-process facilitator configuration are recorded in `evidence/e2e-api-testnet.json`.
