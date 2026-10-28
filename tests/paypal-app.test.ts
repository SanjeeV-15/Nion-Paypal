import { afterEach, describe, expect, it } from "vitest";
import { PayPalError, type ChargeRequest, type PayPalClient } from "../src/paypal/client.js";
import type { WalletSnapshot } from "../src/wallet.js";
import { startApp, stopApps } from "./helpers.js";

afterEach(stopApps);

const APPROVE = "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S";
const chat = (message: string) => ({ message });
const manual: RequestInit = { redirect: "manual" };

function fakePayPal(overrides: Record<string, unknown> = {}) {
  let n = 0;
  const calls = {
    setups: [] as string[],
    wallets: [] as { setupId: string; requestId: string }[],
    deleted: [] as string[],
    charges: [] as ChargeRequest[],
  };
  const client = {
    createSetupToken: async () => {
      const id = `SETUP${++n}`;
      calls.setups.push(id);
      return { id, approveUrl: APPROVE };
    },
    createSavedWallet: async (setupId: string, requestId: string) => {
      calls.wallets.push({ setupId, requestId });
      return { vaultId: `VAULT-${setupId}`, customerId: "cust", email: "buyer@example.com" };
    },
    deleteSavedWallet: async (vaultId: string) => {
      calls.deleted.push(vaultId);
    },
    charge: async (req: ChargeRequest) => {
      calls.charges.push(req);
      return { orderId: "ORDER", captureId: `CAP-${req.reference.slice(0, 8)}`, status: "COMPLETED" };
    },
    ...overrides,
  };
  return { paypal: client as unknown as PayPalClient, calls };
}

/** Starts the app with a fake PayPal and walks one visitor through connecting. */
async function connected(overrides: Record<string, unknown> = {}) {
  const fake = fakePayPal(overrides);
  const app = await startApp({ paypal: fake.paypal });
  await app.call("/api/paypal/connect", {});
  const setupId = fake.calls.setups.at(-1) as string;
  await app.call(`/api/paypal/return?approval_token_id=${setupId}`, undefined, manual);
  return { ...fake, ...app, setupId };
}

const wallet = async (app: { call: (p: string) => Promise<{ json: { wallet: WalletSnapshot } }> }) =>
  (await app.call("/api/wallet")).json.wallet;

describe("connecting PayPal", () => {
  it("runs in sandbox mode and starts unconnected", async () => {
    const { paypal } = fakePayPal();
    const app = await startApp({ paypal });
    const w = await wallet(app);
    expect(w.mode).toBe("sandbox");
    expect(w.paypal).toEqual({ connected: false });
  });

  it("stays in demo mode, with no PayPal routes, when there is no PayPal client", async () => {
    const app = await startApp();
    expect((await wallet(app)).paypal).toBeNull();
    expect((await app.call("/api/paypal/connect", {})).status).toBe(404);
  });

  it("hands back PayPal's approval link and remembers the setup token", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    const res = await app.call("/api/paypal/connect", {});
    expect(res.status).toBe(200);
    expect(res.json.approveUrl).toBe(APPROVE);
    expect(calls.setups).toHaveLength(1);
  });

  it("sends PayPal our own return addresses, not anything from the request", async () => {
    const seen: { returnUrl?: string; cancelUrl?: string } = {};
    const { paypal } = fakePayPal({
      createSetupToken: async (args: { returnUrl: string; cancelUrl: string }) => {
        Object.assign(seen, args);
        return { id: "S", approveUrl: APPROVE };
      },
    });
    const app = await startApp({ paypal, publicBaseUrl: "https://nion.example.com/" });
    await app.call("/api/paypal/connect", {}, { headers: { "Content-Type": "application/json", Host: "evil.example" } });
    expect(seen.returnUrl).toBe("https://nion.example.com/api/paypal/return");
    expect(seen.cancelUrl).toBe("https://nion.example.com/api/paypal/cancel");
  });

  it("connects after the buyer approves, using the setup token as an idempotency key", async () => {
    const app = await connected();
    const w = await wallet(app);
    expect(w.paypal).toEqual({ connected: true, email: "buyer@example.com" });
    expect(app.calls.wallets).toEqual([{ setupId: app.setupId, requestId: `wallet-${app.setupId}` }]);
  });

  it("redirects the buyer back to the page after approval", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    await app.call("/api/paypal/connect", {});
    const res = await app.call(`/api/paypal/return?approval_token_id=${calls.setups[0]}`, undefined, manual);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?paypal=connected");
  });

  it("refuses a return that carries a different setup token", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    await app.call("/api/paypal/connect", {});
    const res = await app.call("/api/paypal/return?approval_token_id=SOMEONE-ELSES", undefined, manual);
    expect(res.headers.get("location")).toBe("/?paypal=failed");
    expect(calls.wallets).toHaveLength(0);
    expect((await wallet(app)).paypal?.connected).toBe(false);
  });

  it("refuses a repeated approval_token_id parameter", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    await app.call("/api/paypal/connect", {});
    const id = calls.setups[0];
    const res = await app.call(`/api/paypal/return?approval_token_id=${id}&approval_token_id=${id}`, undefined, manual);
    expect(res.headers.get("location")).toBe("/?paypal=failed");
    expect(calls.wallets).toHaveLength(0);
  });

  it("cannot be completed from another visitor's session", async () => {
    const { paypal, calls } = fakePayPal();
    const alice = await startApp({ paypal });
    await alice.call("/api/paypal/connect", {});
    const bob = await startApp({ paypal });
    const res = await bob.call(`/api/paypal/return?approval_token_id=${calls.setups[0]}`, undefined, manual);
    expect(res.headers.get("location")).toBe("/?paypal=failed");
    expect(calls.wallets).toHaveLength(0);
    expect((await wallet(bob)).paypal?.connected).toBe(false);
  });

  it("fails cleanly when nothing was started", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    const res = await app.call("/api/paypal/return?approval_token_id=X", undefined, manual);
    expect(res.headers.get("location")).toBe("/?paypal=failed");
    expect(calls.wallets).toHaveLength(0);
  });

  it("treats a reloaded return page as already connected and saves only one wallet", async () => {
    const app = await connected();
    const again = await app.call(`/api/paypal/return?approval_token_id=${app.setupId}`, undefined, manual);
    expect(again.headers.get("location")).toBe("/?paypal=connected");
    expect(app.calls.wallets).toHaveLength(1);
  });

  it("fails cleanly when PayPal will not save the wallet, and lets the buyer try again", async () => {
    let fail = true;
    const { paypal, calls } = fakePayPal({
      createSavedWallet: async (setupId: string) => {
        if (fail) throw new PayPalError("not approved", { uncertain: false });
        return { vaultId: `V-${setupId}`, email: "buyer@example.com" };
      },
    });
    const app = await startApp({ paypal });
    await app.call("/api/paypal/connect", {});
    const first = await app.call(`/api/paypal/return?approval_token_id=${calls.setups[0]}`, undefined, manual);
    expect(first.headers.get("location")).toBe("/?paypal=failed");
    expect((await wallet(app)).paypal?.connected).toBe(false);

    fail = false;
    await app.call("/api/paypal/connect", {});
    await app.call(`/api/paypal/return?approval_token_id=${calls.setups[1]}`, undefined, manual);
    expect((await wallet(app)).paypal?.connected).toBe(true);
  });

  it("forgets the setup when the buyer cancels on PayPal", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    await app.call("/api/paypal/connect", {});
    const cancel = await app.call("/api/paypal/cancel", undefined, manual);
    expect(cancel.headers.get("location")).toBe("/?paypal=cancelled");
    const late = await app.call(`/api/paypal/return?approval_token_id=${calls.setups[0]}`, undefined, manual);
    expect(late.headers.get("location")).toBe("/?paypal=failed");
  });

  it("will not start a second connection while connected", async () => {
    const app = await connected();
    const res = await app.call("/api/paypal/connect", {});
    expect(res.status).toBe(409);
    expect(res.json.wallet.paypal.connected).toBe(true);
  });

  it("explains a PayPal outage on connect and stores nothing", async () => {
    const { paypal, calls } = fakePayPal({
      createSetupToken: async () => {
        throw new PayPalError("down", { status: 503, uncertain: true });
      },
    });
    const app = await startApp({ paypal });
    const res = await app.call("/api/paypal/connect", {});
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/couldn't reach PayPal/);
    const late = await app.call("/api/paypal/return?approval_token_id=X", undefined, manual);
    expect(late.headers.get("location")).toBe("/?paypal=failed");
    expect(calls.wallets).toHaveLength(0);
  });
});

describe("disconnecting", () => {
  it("deletes the saved wallet at PayPal and stops payments", async () => {
    const app = await connected();
    const res = await app.call("/api/paypal/disconnect", {});
    expect(res.json.wallet.paypal.connected).toBe(false);
    expect(app.calls.deleted).toEqual([`VAULT-${app.setupId}`]);
    const pay = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(pay.json.reply).toMatch(/isn't connected/);
    expect(app.calls.charges).toHaveLength(0);
  });

  it("stays connected if PayPal cannot delete the wallet", async () => {
    const app = await connected({
      deleteSavedWallet: async () => {
        throw new PayPalError("boom", { status: 500, uncertain: true });
      },
    });
    const res = await app.call("/api/paypal/disconnect", {});
    expect(res.status).toBe(502);
    expect(res.json.wallet.paypal.connected).toBe(true);
  });

  it("treats a wallet PayPal no longer knows as already gone", async () => {
    const app = await connected({
      deleteSavedWallet: async () => {
        throw new PayPalError("not found", { status: 404, uncertain: false });
      },
    });
    const res = await app.call("/api/paypal/disconnect", {});
    expect(res.json.wallet.paypal.connected).toBe(false);
  });

  it("is fine when nothing is connected", async () => {
    const { paypal } = fakePayPal();
    const app = await startApp({ paypal });
    const res = await app.call("/api/paypal/disconnect", {});
    expect(res.status).toBe(200);
    expect(res.json.wallet.paypal.connected).toBe(false);
  });
});

describe("paying through PayPal", () => {
  it("asks to connect first, and reserves nothing", async () => {
    const { paypal, calls } = fakePayPal();
    const app = await startApp({ paypal });
    const res = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/isn't connected yet/);
    expect(res.json.wallet.spentCents).toBe(0);
    expect(res.json.wallet.activity).toHaveLength(0);
    expect(calls.charges).toHaveLength(0);
  });

  it("charges the saved wallet with the right details and records the capture", async () => {
    const app = await connected();
    const res = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toBe("Paid $12.00 to Sunrise Cafe.");
    expect(app.calls.charges).toHaveLength(1);
    const charge = app.calls.charges[0] as ChargeRequest;
    expect(charge).toMatchObject({
      vaultId: `VAULT-${app.setupId}`,
      amountCents: 1200,
      currency: "USD",
      description: "Nion Pay: Sunrise Cafe",
      customId: "sunrise-cafe",
    });
    const entry = res.json.wallet.activity[0];
    expect(entry).toMatchObject({ status: "completed", ref: `CAP-${charge.reference.slice(0, 8)}` });
    expect(charge.reference).toBe(entry.id);
  });

  it("does not charge until the user confirms a bigger payment", async () => {
    const app = await connected();
    const ask = await app.call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    expect(ask.json.wallet.pending).not.toBeNull();
    expect(app.calls.charges).toHaveLength(0);
    const yes = await app.call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    expect(yes.json.reply).toBe("Paid $48.00 to Blue Door Taxi.");
    expect(app.calls.charges).toHaveLength(1);
  });

  it("charges only once however often the confirm button is pressed", async () => {
    const app = await connected();
    const ask = await app.call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const proposalId = ask.json.wallet.pending.proposalId;
    const results = await Promise.all([
      app.call("/api/confirm", { proposalId }),
      app.call("/api/confirm", { proposalId }),
      app.call("/api/confirm", { proposalId }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(app.calls.charges).toHaveLength(1);
    expect((await wallet(app)).spentCents).toBe(4800);
  });

  it("releases the money when PayPal clearly declines", async () => {
    const app = await connected({
      charge: async () => {
        throw new PayPalError("The instrument presented was declined.", { status: 422, code: "INSTRUMENT_DECLINED", uncertain: false });
      },
    });
    const res = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/did not go through, and nothing was charged/);
    expect(res.json.wallet.spentCents).toBe(0);
    expect(res.json.wallet.activity[0].status).toBe("failed");
  });

  it("keeps the money held and says so when PayPal's answer is uncertain", async () => {
    const app = await connected({
      charge: async () => {
        throw new PayPalError("Lost the connection to PayPal.", { uncertain: true });
      },
    });
    const res = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/couldn't confirm whether the \$12\.00 to Sunrise Cafe payment went through/);
    expect(res.json.reply).toMatch(/counted against your daily limit/);
    expect(res.json.wallet.spentCents).toBe(1200);
    expect(res.json.wallet.remainingCents).toBe(13_800);
    expect(res.json.wallet.activity[0].status).toBe("unconfirmed");
  });

  it("asks before repeating a payment whose first attempt was uncertain", async () => {
    const app = await connected({
      charge: async () => {
        throw new PayPalError("Lost the connection to PayPal.", { uncertain: true });
      },
    });
    await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    const again = await app.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(again.json.wallet.pending).toMatchObject({ reasons: ["possible_duplicate"] });
  });

  it("keeps each visitor's saved wallet to themselves", async () => {
    const app = await connected();
    const stranger = await startApp({ paypal: app.paypal });
    const res = await stranger.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/isn't connected yet/);
    expect(app.calls.charges).toHaveLength(0);
  });
});
