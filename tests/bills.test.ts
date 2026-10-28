import { describe, expect, it } from "vitest";
import { daysUntil, describeBill, payBill, sampleBills } from "../src/bills.js";
import { PaymentUncertainError, answerPending, demoExecutor, type Executor } from "../src/payments.js";
import { ALL_PAYEES, BILLERS, MERCHANTS } from "../src/merchants.js";
import { defaultPolicy } from "../src/config.js";
import { SessionStore } from "../src/sessions.js";
import { SpendingGate } from "../src/limits/gate.js";
import type { Session } from "../src/sessions.js";
import { makeSession } from "./helpers.js";

const NOW = Date.parse("2026-11-02T15:00:00Z");

describe("sample bills", () => {
  it("are due on the days after the visitor arrives, as dates in UTC", () => {
    const bills = sampleBills(NOW);
    expect(bills.map((b) => [b.id, b.dueDate])).toEqual([
      ["phone", "2026-11-05"],
      ["credit-card", "2026-11-08"],
      ["electric", "2026-11-11"],
      ["rent", "2026-11-14"],
    ]);
    expect(bills.every((b) => b.status === "due")).toBe(true);
  });

  it("are all paid to payees the spending gate approves", () => {
    const approved = new Set(defaultPolicy({}).approvedMerchants);
    for (const bill of sampleBills(NOW)) expect(approved.has(bill.payeeId), bill.id).toBe(true);
    expect(BILLERS.every((b) => approved.has(b.id))).toBe(true);
    expect(ALL_PAYEES).toHaveLength(MERCHANTS.length + BILLERS.length);
  });

  it("include one the limits must refuse, so the demo shows the limit working", () => {
    const rent = sampleBills(NOW).find((b) => b.id === "rent");
    expect(rent?.amountCents).toBeGreaterThan(defaultPolicy({}).perPurchaseCapCents);
  });

  it("can all be paid in one day except the ones that break a limit", () => {
    const small = sampleBills(NOW).filter((b) => b.id !== "rent");
    const total = small.reduce((sum, b) => sum + b.amountCents, 0);
    expect(total).toBeLessThanOrEqual(defaultPolicy({}).dailyCapCents);
  });

  it("start fresh for every visitor", () => {
    let now = NOW;
    const store = new SessionStore({ createGate: () => new SpendingGate(defaultPolicy({})), ttlMs: 1000, max: 5, now: () => now });
    const a = store.get(undefined).session;
    a.bills[0]!.status = "paid";
    now += 10;
    const b = store.get(undefined).session;
    expect(b.bills[0]?.status).toBe("due");
    expect(a.bills[0]?.dueDate).toBe("2026-11-05");
  });
});

describe("daysUntil", () => {
  it("counts whole UTC days, negative once overdue", () => {
    expect(daysUntil("2026-11-02", NOW)).toBe(0);
    expect(daysUntil("2026-11-05", NOW)).toBe(3);
    expect(daysUntil("2026-11-01", NOW)).toBe(-1);
  });

  it("does not change through the day", () => {
    expect(daysUntil("2026-11-03", Date.parse("2026-11-02T00:00:01Z"))).toBe(1);
    expect(daysUntil("2026-11-03", Date.parse("2026-11-02T23:59:59Z"))).toBe(1);
  });
});

describe("describeBill", () => {
  it("gives the model the facts, in dollars and days", () => {
    const [phone] = sampleBills(NOW);
    expect(describeBill(phone!, NOW, "USD")).toEqual({
      id: "phone",
      name: "Phone plan",
      pay_to: "Skyline Mobile",
      amount_usd: 42.5,
      amount_text: "$42.50",
      due_date: "2026-11-05",
      due_in_days: 3,
      status: "due",
    });
  });

  it("calls a past-due unpaid bill overdue, but a paid one stays paid", () => {
    const [phone] = sampleBills(NOW - 10 * 24 * 60 * 60 * 1000);
    expect(describeBill(phone!, NOW, "USD").status).toBe("overdue");
    phone!.status = "paid";
    expect(describeBill(phone!, NOW, "USD").status).toBe("paid");
  });
});

/** Every sample bill is over the ask-first line, so paying one takes a yes. */
async function payWithYes(session: Session, billId: string, executor: Executor) {
  const asked = await payBill(session, billId, executor);
  if (asked.kind !== "asked") return asked;
  return answerPending(session, "yes", executor);
}

describe("payBill", () => {
  it("takes the amount and payee from the bill and marks it paid", async () => {
    const session = makeSession();
    const out = await payWithYes(session, "electric", demoExecutor);
    expect(out.kind).toBe("paid");
    expect(out.message).toMatch(/\$38\.20 to Bright Power/);
    expect(session.bills.find((b) => b.id === "electric")?.status).toBe("paid");
    expect(session.gate.history()[0]?.request).toEqual({ merchantId: "bright-power", amountCents: 3820, currency: "USD" });
  });

  it("holds a bill over the auto-approve line for the user's yes, then pays and marks it on yes", async () => {
    const session = makeSession();
    const ask = await payBill(session, "phone", demoExecutor);
    expect(ask.kind).toBe("asked");
    expect(session.pending).toMatchObject({ merchantId: "skyline-mobile", amountCents: 4250, billId: "phone" });
    expect(session.bills.find((b) => b.id === "phone")?.status).toBe("due");

    const yes = await answerPending(session, "yes", demoExecutor);
    expect(yes.kind).toBe("paid");
    expect(session.bills.find((b) => b.id === "phone")?.status).toBe("paid");
    expect(session.pending).toBeNull();
    expect(session.gate.spentToday()).toBe(4250);
  });

  it("leaves the bill due when the user says no", async () => {
    const session = makeSession();
    await payBill(session, "phone", demoExecutor);
    await answerPending(session, "no", demoExecutor);
    expect(session.bills.find((b) => b.id === "phone")?.status).toBe("due");
    expect(session.gate.spentToday()).toBe(0);
  });

  it("refuses the rent, because it is over the per-payment limit, and leaves it due", async () => {
    const session = makeSession();
    const out = await payBill(session, "rent", demoExecutor);
    expect(out.kind).toBe("denied");
    expect(out.message).toMatch(/limit for one payment/);
    expect(session.bills.find((b) => b.id === "rent")?.status).toBe("due");
    expect(session.gate.history()).toHaveLength(0);
  });

  it("will not pay a bill twice", async () => {
    const session = makeSession();
    await payWithYes(session, "electric", demoExecutor);
    const again = await payBill(session, "electric", demoExecutor);
    expect(again).toMatchObject({ kind: "unavailable", message: expect.stringMatching(/already paid/) });
    expect(session.gate.history()).toHaveLength(1);
  });

  it("does not know a bill it was never given", async () => {
    const out = await payBill(makeSession(), "mortgage", demoExecutor);
    expect(out).toMatchObject({ kind: "unavailable", message: expect.stringMatching(/don't have a bill/) });
  });

  it("does not start when PayPal is not ready", async () => {
    const session = makeSession();
    const executor: Executor = { ...demoExecutor, ready: () => "Connect PayPal first." };
    expect(await payBill(session, "electric", executor)).toEqual({ kind: "not_ready", message: "Connect PayPal first." });
    expect(session.gate.history()).toHaveLength(0);
  });

  it("leaves the bill due when the payment clearly fails, so it can be tried again", async () => {
    const session = makeSession();
    const failing: Executor = { ...demoExecutor, pay: async () => { throw new Error("declined"); } };
    expect((await payWithYes(session, "electric", failing)).kind).toBe("failed");
    expect(session.bills.find((b) => b.id === "electric")?.status).toBe("due");
    expect(session.gate.spentToday()).toBe(0);
  });

  it("marks the bill unconfirmed when the result is doubtful, and then refuses to pay it again", async () => {
    const session = makeSession();
    const doubtful: Executor = { ...demoExecutor, pay: async () => { throw new PaymentUncertainError("lost"); } };
    expect((await payWithYes(session, "electric", doubtful)).kind).toBe("unconfirmed");
    expect(session.bills.find((b) => b.id === "electric")?.status).toBe("unconfirmed");
    expect(session.gate.spentToday()).toBe(3820);

    const again = await payBill(session, "electric", demoExecutor);
    expect(again.kind).toBe("unavailable");
    expect(again.message).toMatch(/won't pay it again/);
    expect(session.gate.history()).toHaveLength(1);
  });

  it("replaces an open question about something else", async () => {
    const session = makeSession();
    session.gate.request({ merchantId: "blue-door-taxi", amountCents: 4800, currency: "USD" });
    await payBill(session, "phone", demoExecutor);
    expect(session.pending?.billId).toBe("phone");
  });

  it("respects the daily limit across bills", async () => {
    const session = makeSession();
    for (const id of ["phone", "credit-card", "electric"]) {
      await payBill(session, id, demoExecutor);
      if (session.pending) await answerPending(session, "yes", demoExecutor);
    }
    expect(session.gate.spentToday()).toBe(4250 + 6000 + 3820);
    // Anything more now fails the daily limit even if it is small.
    const extra = session.gate.request({ merchantId: "sunrise-cafe", amountCents: 1500, currency: "USD" });
    expect(extra.status).toBe("denied");
  });
});
