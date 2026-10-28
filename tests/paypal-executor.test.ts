import { describe, expect, it } from "vitest";
import { SpendingGate, type LedgerEntry } from "../src/limits/gate.js";
import { defaultPolicy } from "../src/config.js";
import { PaymentUncertainError } from "../src/payments.js";
import { PayPalError, type ChargeRequest } from "../src/paypal/client.js";
import { PayPalExecutor } from "../src/paypal/executor.js";
import type { Session } from "../src/sessions.js";

function session(connected: boolean): Session {
  return {
    id: "s",
    gate: new SpendingGate(defaultPolicy({}), { merchantName: () => "Sunrise Cafe" }),
    pending: null,
    paypal: connected ? { vaultId: "VAULT-1" } : null,
    paypalSetupId: null,
    history: [],
    lastSeen: 0,
  };
}

const entry: LedgerEntry = {
  id: "ledger-1",
  request: { merchantId: "sunrise-cafe", amountCents: 1200, currency: "USD" },
  at: 0,
  status: "pending",
};

describe("PayPalExecutor", () => {
  it("says payments cannot start until PayPal is connected", () => {
    const executor = new PayPalExecutor({ charge: async () => ({ orderId: "o", captureId: "c", status: "COMPLETED" }) });
    expect(executor.ready(session(false))).toMatch(/Connect PayPal/);
    expect(executor.ready(session(true))).toBeNull();
  });

  it("charges the saved wallet and returns the capture id", async () => {
    const seen: ChargeRequest[] = [];
    const executor = new PayPalExecutor({
      charge: async (req) => {
        seen.push(req);
        return { orderId: "o", captureId: "CAP-9", status: "COMPLETED" };
      },
    });
    expect(await executor.pay(session(true), entry)).toBe("CAP-9");
    expect(seen).toEqual([
      {
        vaultId: "VAULT-1",
        amountCents: 1200,
        currency: "USD",
        description: "Nion Pay: Sunrise Cafe",
        customId: "sunrise-cafe",
        reference: "ledger-1",
      },
    ]);
  });

  it("refuses to pay without a connected wallet and never calls PayPal", async () => {
    let called = false;
    const executor = new PayPalExecutor({
      charge: async () => {
        called = true;
        return { orderId: "o", captureId: "c", status: "COMPLETED" };
      },
    });
    await expect(executor.pay(session(false), entry)).rejects.toThrow(/not connected/);
    expect(called).toBe(false);
  });

  it("turns an uncertain PayPal failure into an uncertain payment, keeping the cause", async () => {
    const cause = new PayPalError("Lost the connection to PayPal.", { uncertain: true });
    const executor = new PayPalExecutor({
      charge: async () => {
        throw cause;
      },
    });
    const err = await executor.pay(session(true), entry).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentUncertainError);
    expect(err.cause).toBe(cause);
  });

  it("lets a clear PayPal failure through as an ordinary failure", async () => {
    const executor = new PayPalExecutor({
      charge: async () => {
        throw new PayPalError("declined", { status: 422, uncertain: false });
      },
    });
    const err = await executor.pay(session(true), entry).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).not.toBeInstanceOf(PaymentUncertainError);
  });

  it("does not turn an unexpected bug into a doubtful payment", async () => {
    const executor = new PayPalExecutor({
      charge: async () => {
        throw new TypeError("our own bug");
      },
    });
    const err = await executor.pay(session(true), entry).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });
});
