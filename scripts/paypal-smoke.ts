// Walks the PayPal sandbox flow one step at a time. Sandbox only.
//   npm run smoke:paypal -- setup            print the link the buyer approves
//   npm run smoke:paypal -- finish           save the approved wallet
//   npm run smoke:paypal -- charge 100       charge it (amount in cents)
//   npm run smoke:paypal -- refund           refund the last charge
//   npm run smoke:paypal -- unlink           delete the saved wallet
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PayPalClient, PayPalError } from "../src/paypal/client.js";

interface State {
  setupTokenId?: string;
  vaultId?: string;
  lastCaptureId?: string;
}

const STATE_FILE = "data/paypal-smoke.json";
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

if (process.env.PAYPAL_ENV !== "sandbox") fail('PAYPAL_ENV must be "sandbox".');
if (!clientId || !clientSecret) fail("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env.");

const paypal = new PayPalClient({ clientId, clientSecret });
const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4310}`;

const [command, arg] = process.argv.slice(2);
const state = await load();

try {
  switch (command) {
    case "setup": {
      const token = await paypal.createSetupToken({
        returnUrl: `${base}/api/paypal/return`,
        cancelUrl: `${base}/api/paypal/cancel`,
        description: "Nion Pay smoke test",
        requestId: randomUUID(),
      });
      state.setupTokenId = token.id;
      await save(state);
      console.log("Setup token created.");
      console.log("Open this link, sign in as the sandbox PERSONAL account, and approve:");
      console.log(token.approveUrl);
      console.log("Afterwards the browser lands on a page that may not load. Copy the full address and send it to me.");
      break;
    }
    case "finish": {
      if (!state.setupTokenId) fail("Run setup first.");
      const wallet = await paypal.createSavedWallet(state.setupTokenId, randomUUID());
      state.vaultId = wallet.vaultId;
      await save(state);
      console.log(`Wallet saved for ${wallet.email ?? "(email not returned)"}. Customer id: ${wallet.customerId ?? "none"}.`);
      break;
    }
    case "charge": {
      if (!state.vaultId) fail("Run finish first.");
      const cents = Number(arg);
      if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 500) fail("Pass a small amount in cents, 1 to 500.");
      const reference = `smoke-${Date.now()}`;
      const charge = await paypal.charge({
        vaultId: state.vaultId,
        amountCents: cents,
        currency: "USD",
        description: "Nion Pay smoke test",
        reference,
      });
      state.lastCaptureId = charge.captureId;
      await save(state);
      console.log(`Charged ${cents} cents. Order ${charge.orderId}, capture ${charge.captureId}, status ${charge.status}.`);
      break;
    }
    case "refund": {
      if (!state.lastCaptureId) fail("Nothing to refund; run charge first.");
      const refund = await paypal.refund(state.lastCaptureId, randomUUID());
      console.log(`Refund ${refund.id} is ${refund.status}.`);
      break;
    }
    case "unlink": {
      if (!state.vaultId) fail("Nothing saved.");
      await paypal.deleteSavedWallet(state.vaultId);
      delete state.vaultId;
      await save(state);
      console.log("Saved wallet deleted.");
      break;
    }
    default:
      fail("Commands: setup | finish | charge <cents> | refund | unlink");
  }
} catch (err) {
  if (err instanceof PayPalError) {
    console.log(`PayPal said no. status=${err.status ?? "-"} code=${err.code ?? "-"} uncertain=${err.uncertain}`);
    console.log(err.message);
    process.exit(2);
  }
  throw err;
}

async function load(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

async function save(s: State): Promise<void> {
  await mkdir("data", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
