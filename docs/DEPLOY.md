# Deploying to Render

The repository includes a Render Blueprint (`render.yaml`), so the service is created from the repo rather than by hand.

## Before you start
- The code is pushed to GitHub and the repository is public.
- You have your Anthropic API key and your PayPal **sandbox** REST app's client ID and secret.

## Steps
1. In the Render dashboard choose **New > Blueprint** and connect the GitHub repository.
2. Render reads `render.yaml` and asks for three values. Paste them there, never into the repo:
   - `ANTHROPIC_API_KEY`
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
3. Check the instance size on the review screen. It must be a paid size (512 MB), not Free: a free service sleeps after 15 minutes, and visitors' wallets live in memory.
4. Apply. When the deploy finishes, open `https://<your-service>.onrender.com/api/health`. It should answer `{"ok":true}`.
5. Open the site, click **Connect PayPal**, sign in as the sandbox buyer, and make a test payment.

## Optional: the demo wallet
A saved sandbox wallet that visitors can use without signing in to PayPal.
1. Get a saved wallet's id by connecting a sandbox buyer once with the smoke tool, then print it: `npm run smoke:paypal -- vault`.
2. In Render open the service's **Environment** tab and add `DEMO_WALLET_VAULT_ID` with that id. Treat it like a password for that sandbox buyer. Saving redeploys the service.
3. Open the site: the page now offers **Use the demo wallet** next to **Connect PayPal**.
Because Render only asks for `sync: false` values when the Blueprint is first created, add this one by hand on an existing service.

## Notes
- The PayPal return address is taken from `RENDER_EXTERNAL_URL`, which Render sets for you. To use a custom domain, set `PUBLIC_BASE_URL` to it.
- `PAYPAL_ENV` is `sandbox` and the server refuses to start with any other value when credentials are present.
- AI calls are capped per visitor (`NION_MAX_AI_PER_HOUR`) and per day (`NION_MAX_AI_PER_DAY`). Past a cap the app drops to its simple mode. Also set a monthly spend limit in the Anthropic console.
- Keep it to a single instance. Sessions are stored in memory.
- Secrets marked `sync: false` are only asked for when the Blueprint is first created. Later changes are made in the service's Environment tab.
