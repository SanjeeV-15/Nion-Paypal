import { describe, expect, it } from "vitest";
import { runTool, TOOLS, usdToCents, describePending } from "../src/agent/tools.js";
import { MERCHANTS } from "../src/merchants.js";
import { demoExecutor, PaymentUncertainError, type Executor } from "../src/payments.js";
import type { Session } from "../src/sessions.js";
import { makeSession } from "./helpers.js";

const json = (r: { content: string }) => JSON.parse(r.content);
const run = (session: Session, name: string, input: unknown, executor: Executor = demoExecutor) =>
  runTool(name, input, { session, executor });

describe("tool list", () => {
  it("has no way for the model to confirm a payment", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["cancel_pending_payment", "get_wallet", "list_bills", "list_merchants", "pay", "pay_bill"]);
  });

  it("limits pay to the approved merchants", () => {
    const pay = TOOLS.find((t) => t.name === "pay");
    const props = (pay?.input_schema as { properties: { merchant_id: { enum: string[] } } }).properties;
    expect(props.merchant_id.enum).toEqual(MERCHANTS.map((m) => m.id));
  });
});

describe("usdToCents", () => {
  it.each([
    [12, 1200],
    [12.5, 1250],
    [0.01, 1],
    [48.05, 4805],
    [19.99, 1999],
    [0.07, 7],
  ])("turns %d dollars into %d cents", (usd, cents) => {
    expect(usdToCents(usd)).toBe(cents);
  });

  it.each([0, -5, 12.345, 0.001, Number.NaN, Number.POSITIVE_INFINITY, 1e300])("rejects %s", (usd) => {
    expect(usdToCents(usd)).toBeNull();
  });
});

describe("list_merchants and get_wallet", () => {
  it("lists the merchants with ids", async () => {
    const out = json(await run(makeSession(), "list_merchants", {}));
    expect(out).toHaveLength(MERCHANTS.length);
    expect(out[0]).toMatchObject({ id: "blue-door-taxi", name: "Blue Door Taxi" });
  });

  it("reports limits, spending and what is waiting, in dollars", async () => {
    const session = makeSession();
    await run(session, "pay", { merchant_id: "sunrise-cafe", amount_usd: 12 });
    await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 48 });
    const wallet = json(await run(session, "get_wallet", {}));
    expect(wallet).toMatchObject({
      currency: "USD",
      payments_ready: true,
      limits: { asks_for_a_yes_above_usd: 25, max_per_payment_usd: 100, max_per_day_usd: 150 },
      spent_today_usd: 12,
      remaining_today_usd: 138,
      waiting_for_the_users_yes: { merchant: "Blue Door Taxi", amount_usd: 48 },
    });
    expect(wallet.recent_payments).toEqual([{ merchant: "Sunrise Cafe", amount_usd: 12, status: "completed" }]);
  });

  it("says why payments are not ready", async () => {
    const executor: Executor = { ...demoExecutor, ready: () => "Connect PayPal first." };
    const wallet = json(await run(makeSession(), "get_wallet", {}, executor));
    expect(wallet).toMatchObject({ payments_ready: false, not_ready_reason: "Connect PayPal first." });
  });
});

describe("pay", () => {
  it("pays a small amount at once", async () => {
    const session = makeSession();
    const out = json(await run(session, "pay", { merchant_id: "sunrise-cafe", amount_usd: 12 }));
    expect(out.status).toBe("paid");
    expect(session.gate.spentToday()).toBe(1200);
  });

  it("holds a bigger payment for the user's own yes and says only they can give it", async () => {
    const session = makeSession();
    const out = json(await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 48 }));
    expect(out.status).toBe("asked");
    expect(out.note).toMatch(/Only the user can confirm/);
    expect(session.pending).toMatchObject({ merchantId: "blue-door-taxi", amountCents: 4800 });
    expect(session.gate.spentToday()).toBe(0);
  });

  it("replaces an open question when asked to pay something else", async () => {
    const session = makeSession();
    await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 48 });
    const oldId = session.pending?.proposalId as string;
    await run(session, "pay", { merchant_id: "harbor-tours", amount_usd: 60 });
    expect(session.pending).toMatchObject({ merchantId: "harbor-tours", amountCents: 6000 });
    expect(session.pending?.proposalId).not.toBe(oldId);
    // The first question is gone for good: a late yes to it pays nothing.
    expect(session.gate.confirm(oldId)).toMatchObject({ status: "denied", reason: "proposal_not_found" });
    expect(session.gate.spentToday()).toBe(0);
  });

  it("reports a refusal with its reason and reserves nothing", async () => {
    const session = makeSession();
    const out = json(await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 150 }));
    expect(out.status).toBe("denied");
    expect(out.message).toMatch(/limit for one payment/);
    expect(session.gate.history()).toHaveLength(0);
  });

  it("does not start when PayPal is not ready", async () => {
    const session = makeSession();
    const executor: Executor = { ...demoExecutor, ready: () => "Connect PayPal first." };
    const out = json(await run(session, "pay", { merchant_id: "sunrise-cafe", amount_usd: 12 }, executor));
    expect(out).toEqual({ status: "not_ready", message: "Connect PayPal first." });
    expect(session.gate.history()).toHaveLength(0);
  });

  it("reports a failed payment and an unconfirmed one truthfully", async () => {
    const failing: Executor = { ...demoExecutor, pay: async () => { throw new Error("declined"); } };
    const failed = json(await run(makeSession(), "pay", { merchant_id: "sunrise-cafe", amount_usd: 12 }, failing));
    expect(failed.status).toBe("failed");

    const doubtful: Executor = { ...demoExecutor, pay: async () => { throw new PaymentUncertainError("lost"); } };
    const session = makeSession();
    const unsure = json(await run(session, "pay", { merchant_id: "sunrise-cafe", amount_usd: 12 }, doubtful));
    expect(unsure.status).toBe("unconfirmed");
    expect(session.gate.spentToday()).toBe(1200);
  });

  it.each([
    ["a string amount", { merchant_id: "sunrise-cafe", amount_usd: "12" }],
    ["a missing amount", { merchant_id: "sunrise-cafe" }],
    ["a missing merchant", { amount_usd: 12 }],
    ["nothing at all", undefined],
  ])("rejects %s as an error the model can read", async (_name, input) => {
    const session = makeSession();
    const out = await run(session, "pay", input);
    expect(out.isError).toBe(true);
    expect(session.gate.history()).toHaveLength(0);
  });

  it.each([0, -5, 12.345])("rejects an amount of %s", async (amount) => {
    const out = await run(makeSession(), "pay", { merchant_id: "sunrise-cafe", amount_usd: amount });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/two decimal places/);
  });

  it("refuses a merchant that is not on the list, even if the model invents one", async () => {
    const session = makeSession();
    const out = json(await run(session, "pay", { merchant_id: "evil-corp", amount_usd: 5 }));
    expect(out.status).toBe("denied");
    expect(session.gate.history()).toHaveLength(0);
  });
});

describe("cancel_pending_payment", () => {
  it("cancels a waiting payment", async () => {
    const session = makeSession();
    await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 48 });
    expect(json(await run(session, "cancel_pending_payment", {})).status).toBe("cancelled");
    expect(session.pending).toBeNull();
    expect(session.gate.spentToday()).toBe(0);
  });

  it("says so when nothing is waiting", async () => {
    expect(json(await run(makeSession(), "cancel_pending_payment", {})).status).toBe("nothing_pending");
  });
});

describe("unknown tools and pending text", () => {
  it("answers an unknown tool with an error, not a crash", async () => {
    const out = await run(makeSession(), "confirm_payment", {});
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/no tool called "confirm_payment"/);
  });

  it("describes a waiting payment for the model's context", async () => {
    const session = makeSession();
    expect(describePending(session)).toBeNull();
    await run(session, "pay", { merchant_id: "blue-door-taxi", amount_usd: 48 });
    expect(describePending(session)).toBe("$48.00 to Blue Door Taxi");
  });
});

describe("bills", () => {
  it("lists every bill with its amount, payee, due date and status", async () => {
    const out = json(await run(makeSession(), "list_bills", {}));
    expect(out.map((b: { id: string }) => b.id)).toEqual(["phone", "credit-card", "electric", "rent"]);
    expect(out[0]).toMatchObject({ name: "Phone plan", pay_to: "Skyline Mobile", amount_usd: 42.5, status: "due" });
    expect(out[0].due_in_days).toBe(3);
  });

  it("keeps the bill payees out of the merchant list", async () => {
    const out = json(await run(makeSession(), "list_merchants", {}));
    expect(out.map((m: { id: string }) => m.id)).not.toContain("skyline-mobile");
    expect(out).toHaveLength(MERCHANTS.length);
  });

  it("pays a bill by id, using the bill's own amount, and holds it for the user's yes", async () => {
    const session = makeSession();
    const out = json(await run(session, "pay_bill", { bill_id: "phone" }));
    expect(out.status).toBe("asked");
    expect(out.message).toMatch(/Pay \$42\.50 to Skyline Mobile\?/);
    expect(out.note).toMatch(/Only the user can confirm/);
    expect(session.pending).toMatchObject({ amountCents: 4250, billId: "phone" });
  });

  it("refuses the rent through the gate and says why", async () => {
    const out = json(await run(makeSession(), "pay_bill", { bill_id: "rent" }));
    expect(out.status).toBe("denied");
    expect(out.message).toMatch(/limit for one payment/);
  });

  it("reports an unknown bill without paying anything", async () => {
    const session = makeSession();
    expect(json(await run(session, "pay_bill", { bill_id: "mortgage" })).status).toBe("unavailable");
    expect((await run(session, "pay_bill", {})).isError).toBe(true);
    expect((await run(session, "pay_bill", { bill_id: 7 })).isError).toBe(true);
    expect(session.gate.history()).toHaveLength(0);
  });

  it("has no amount for the model to change", () => {
    const tool = TOOLS.find((t) => t.name === "pay_bill");
    const props = (tool?.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["bill_id"]);
  });

  it("will not let pay be used to pay a bill payee with a made-up amount", async () => {
    const session = makeSession();
    const out = await run(session, "pay", { merchant_id: "maple-apartments", amount_usd: 5 });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Use pay_bill/);
    expect(session.gate.history()).toHaveLength(0);
  });

  it("offers pay only the merchants, not the bill payees", () => {
    const pay = TOOLS.find((t) => t.name === "pay");
    const ids = (pay?.input_schema as { properties: { merchant_id: { enum: string[] } } }).properties.merchant_id.enum;
    expect(ids).not.toContain("maple-apartments");
  });
});
