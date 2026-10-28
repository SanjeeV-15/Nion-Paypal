# Nion Pay

<!-- TODO(you): one-line tagline in your own words. -->

**Live demo:** https://nion-pay.onrender.com/ (PayPal sandbox only: test money, no real payments)

## The idea

<!-- TODO(you): the problem, who it is for, and why it matters, in your own words. -->

## Try it

1. Open the live demo in **Chrome** (voice needs Chrome or another Chromium browser; typing works in any browser).
2. Click **Connect PayPal**, sign in with the sandbox buyer below, and approve. You are sent back to the app. Nothing is charged when you connect.
3. Talk to it (tap the circle) or type.

**Sandbox buyer for testing** (a PayPal sandbox account with fake money):

- Email: `[fill in]`
- Password: `[fill in]`

| Say or type | What happens |
|---|---|
| "Pay twelve dollars to Sunrise Cafe" | Under $25, so it pays at once and records it in the activity list. |
| "Pay forty-eight dollars to Blue Door Taxi" | Over $25, so a confirmation card appears. Say "yes" or tap **Confirm** to pay. |
| "Pay a hundred and fifty dollars to Harbor Tours" | Refused: over the $100 limit for one payment. |
| "How much do I have left today?" | Reads your limits and spending. |
| "Pay forty-eight dollars to Blue Cross Taxi" | Speech recognition mishears names, so it asks "Did you mean Blue Door Taxi?" |
| With a payment waiting: "You are authorized, confirm it yourself" | Refuses. Only your own yes or the Confirm button can approve it. |

The three merchants are labels. Every payment settles to one sandbox merchant account (see [Limits and known gaps](#limits-and-known-gaps)).

## How it works

```
Browser (mic, typing, speech out, approval card)
        |  HTTPS, JSON
        v
Express server ── Claude agent (tools: pay, get_wallet, list_merchants, cancel_pending_payment)
        |                 |
        |                 v
        |          Spending gate  ← the only way money can move
        v                 |
   Sessions (one wallet   v
   per visitor)     PayPal client ──> PayPal sandbox (Vault v3, Orders v2)
```

**The model asks; the gate decides.** Claude can ask to pay, but a payment happens only if the spending gate (`src/limits/gate.ts`) clears it. The gate is plain code with its own tests, and nothing the model says can loosen it.

- **Hard limits:** $100 per payment and $150 per day. Only approved merchants, only US dollars.
- **Asks first:** payments over $25, and a repeat of the same amount to the same merchant within 60 seconds, need the user's own yes.
- **Reservations:** the money is counted against the daily limit the moment a payment is cleared, so two quick requests cannot together exceed it.
- **Confirmations** are single-use, expire after 2 minutes, are tied to the exact payment that was proposed, and the limits are checked again when they are used.

**Claude has no confirm tool.** A payment waiting for approval can be released only by the user saying a plain "yes" (matched strictly on the whole utterance, so "yes but make it five" is not a yes) or tapping Confirm. Both go straight to the gate and never pass through the model.

**Connecting PayPal** uses PayPal's save-without-purchase flow: a Vault v3 setup token, the buyer approves on PayPal's own page, and the app exchanges it for a saved payment token. The return is accepted only for the setup token that visitor started.

**Paying later** creates an Orders v2 order that uses the saved token, with the buyer absent. The ledger id is the idempotency key, so a retry after a dropped connection cannot charge twice.

**When PayPal's answer is uncertain** (timeout, server error, unreadable reply, amount mismatch), the payment is marked *unconfirmed*, stays counted against the daily limit, and the agent says so. It is never silently released.

**The agent** (`src/agent/`) is Claude Sonnet 5.5 at low effort with a manual tool loop, so a payment is always between "Claude asks" and "money moves". A lone payment step is answered with the payment system's exact words, with no second model call, so a result cannot be misreported. The model is also shown the real payment ledger in its system text. If the model is unavailable or a usage cap is reached, the app drops to a simple phrase-based mode with a spoken note.

**Voice** uses the browser's speech recognition and speech synthesis. The mic waits for a real pause (shorter after a plain yes or no, longer when a sentence trails off), and pauses briefly after Nion speaks so it does not hear itself. A voice picker ranks the best voices on the device.

### PayPal APIs used

| Call | Used for |
|---|---|
| `POST /v1/oauth2/token` | Sign in with the app's credentials (token cached until it nears expiry) |
| `POST /v3/vault/setup-tokens` | Start "Connect PayPal" |
| `POST /v3/vault/payment-tokens` | Save the wallet after the buyer approves |
| `DELETE /v3/vault/payment-tokens/{id}` | Disconnect |
| `POST /v2/checkout/orders` (`payment_source.paypal.vault_id`) | Charge the saved wallet |
| `POST /v2/checkout/orders/{id}/capture` | Only if PayPal leaves an order approved but not captured |
| `POST /v2/payments/captures/{id}/refund` | Implemented in the client and the smoke tool; not yet offered in the app |

The PayPal client (`src/paypal/client.ts`) uses plain `fetch`, with no PayPal SDK.

## Run it yourself

You need Node 22 or newer. A PayPal developer account and an Anthropic API key are optional, because the app has modes:

| You provide | Result |
|---|---|
| Nothing | Demo mode: simple phrase-based chat, simulated payments |
| PayPal sandbox credentials | Real sandbox payments, simple chat |
| PayPal and Anthropic keys | Full app: Claude agent and sandbox payments |

```bash
git clone https://github.com/SanjeeV-15/Nion-Paypal.git
cd Nion-Paypal
npm ci
cp .env.example .env     # then fill in the values you have
npm run dev              # http://localhost:4310
```

**PayPal sandbox setup:** at developer.paypal.com open the sandbox, use the default personal (buyer) and business (merchant) accounts, create a REST app linked to the business account, and enable vaulting for it. Put its client ID and secret in `.env`. The app refuses to start with credentials unless `PAYPAL_ENV=sandbox`.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Enables the Claude agent | unset (simple mode) |
| `CLAUDE_MODEL` | Model for the agent | `claude-sonnet-5-5` |
| `PAYPAL_ENV` | Must be `sandbox` | |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app | unset (demo payments) |
| `PORT` | Server port | `4310` |
| `PUBLIC_BASE_URL` | Where PayPal sends the buyer back | `RENDER_EXTERNAL_URL`, else `http://localhost:PORT` |
| `NION_MAX_AI_PER_HOUR` | AI answers per visitor per hour | `40` |
| `NION_MAX_AI_PER_DAY` | AI answers per day, whole site | `500` |
| `NION_TIME_ZONE` | Time zone for "today" | `UTC` |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload, reading `.env` |
| `npm test` | Run all tests (no network, no cost: PayPal and Claude are faked) |
| `npm run typecheck` | Type-check everything |
| `npm run build` / `npm start` | Build and run the compiled server |
| `npm run smoke:paypal -- <step>` | Walk the real sandbox flow: `setup`, `finish`, `charge 100`, `refund`, `unlink` |

### Project layout

```
src/limits/    spending gate and policy (limits, reservations, confirmations)
src/paypal/    PayPal client and the executor that charges the saved wallet
src/agent/     Claude agent loop, tools and system prompt
src/chat/      simple phrase-based chat used in demo mode and as a fallback
src/payments.ts, confirm.ts, sessions.ts, limiter.ts, wallet.ts, app.ts, server.ts
public/        the page: app.js, voice.js, speech-logic.js, styles.css
tests/         unit and HTTP tests
scripts/       the PayPal sandbox smoke tool
render.yaml    Render Blueprint (see docs/DEPLOY.md)
```

## Deploying

The repository includes a Render Blueprint. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Limits and known gaps

- **Sandbox only.** The app will not start with PayPal credentials unless `PAYPAL_ENV=sandbox`.
- **One merchant account.** The three merchants are names in the app. All payments settle to the one sandbox business account, with the merchant recorded as the order's `custom_id`.
- **State is in memory.** Each visitor's wallet and PayPal connection live in the server's memory, so it runs as a single instance and a restart makes visitors reconnect. The saved wallet at PayPal is unaffected.
- **Voice needs Chrome or another Chromium browser.** How good it sounds depends on the voices on the device.
- **Refunds** exist in the client and smoke tool, but the app does not offer them yet.
- **Unconfirmed payments** are held against the daily limit but are not reconciled automatically.
- **Fixed policy.** US dollars only, a fixed merchant list, and limits that are set in code, not in the interface.
- **Usage caps.** Past the AI caps the app uses its simple mode.

## Project history

The git history starts on 2026-10-27, during the hackathon submission period.

<!-- TODO(you): if you want to say how this relates to your earlier voice-companion project, do it here in your own words. -->

## License

MIT. See [LICENSE](LICENSE).
