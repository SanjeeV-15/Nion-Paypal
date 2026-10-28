import { createApp } from "./app.js";
import { PayPalClient } from "./paypal/client.js";

const port = Number(process.env.PORT ?? 4310);

let paypal: PayPalClient | undefined;
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (clientId && clientSecret) {
  if (process.env.PAYPAL_ENV !== "sandbox") {
    throw new Error('PAYPAL_ENV must be "sandbox". This app never uses live PayPal credentials.');
  }
  paypal = new PayPalClient({ clientId, clientSecret });
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

createApp({ paypal, publicBaseUrl }).listen(port, () => {
  console.log(`nion-paypal listening on ${publicBaseUrl} (${paypal ? "PayPal sandbox" : "demo mode, no PayPal credentials"})`);
});
