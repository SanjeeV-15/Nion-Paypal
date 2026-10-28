import { beforeEach, describe, expect, it } from "vitest";
import { SpendingGate } from "../src/limits/gate.js";
import type { Policy } from "../src/limits/policy.js";

const T0 = Date.parse("2026-11-02T15:00:00Z");

const policy: Policy = {
  currency: "USD",
  timeZone: "America/New_York",
  autoApproveUpToCents: 2_500,
  perPurchaseCapCents: 10_000,
  dailyCapCents: 15_000,
  approvedMerchants: ["blue-door-taxi", "sunrise-cafe"],
  duplicateWindowMs: 60_000,
  confirmationTtlMs: 120_000,
};

let clock = T0;
let seq = 0;

function makeGate(overrides: Partial<Policy> = {}) {
  return new SpendingGate(
    { ...policy, ...overrides },
    { now: () => clock, newId: () => `id-${++seq}` },
  );
}

const pay = (merchantId: string, amountCents: number, currency = "USD") => ({
  merchantId,
  amountCents,
  currency,
});

beforeEach(() => {
  clock = T0;
  seq = 0;
});

describe("hard denials", () => {
  it.each([0, -500, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
    "rejects amount %s",
    (amount) => {
      const out = makeGate().request(pay("sunrise-cafe", amount));
      expect(out).toMatchObject({ status: "denied", reason: "invalid_amount" });
    },
  );

  it("rejects another currency", () => {
    expect(makeGate().request(pay("sunrise-cafe", 500, "EUR"))).toMatchObject({
      status: "denied",
      reason: "currency_mismatch",
    });
  });

  it("accepts a lowercase currency code", () => {
    expect(makeGate().request(pay("sunrise-cafe", 500, "usd")).status).toBe("approved");
  });

  it("rejects a merchant that is not on the list, however close the name", () => {
    const gate = makeGate();
    for (const id of ["unknown-shop", "Sunrise-Cafe", "sunrise-cafe-2", ""]) {
      expect(gate.request(pay(id, 500))).toMatchObject({
        status: "denied",
        reason: "merchant_not_approved",
      });
    }
  });

  it("rejects a payment over the per-purchase cap even though it could be confirmed", () => {
    const out = makeGate().request(pay("blue-door-taxi", 10_001));
    expect(out).toMatchObject({ status: "denied", reason: "over_purchase_cap" });
  });

  it("allows exactly the per-purchase cap with a yes", () => {
    const out = makeGate().request(pay("blue-door-taxi", 10_000));
    expect(out.status).toBe("needs_confirmation");
  });
});

describe("auto-approve and confirmation", () => {
  it("approves at the auto-approve line and asks one cent above it", () => {
    const gate = makeGate();
    expect(gate.request(pay("sunrise-cafe", 2_500)).status).toBe("approved");
    clock += 61_000;
    const out = gate.request(pay("sunrise-cafe", 2_501));
    expect(out).toMatchObject({ status: "needs_confirmation", reasons: ["above_auto_approve"] });
  });

  it("does not spend anything until the user confirms", () => {
    const gate = makeGate();
    gate.request(pay("blue-door-taxi", 4_800));
    expect(gate.spentToday()).toBe(0);
    expect(gate.history()).toHaveLength(0);
  });

  it("reserves the money once the user says yes", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 4_800));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    const out = gate.confirm(ask.proposalId);
    expect(out.status).toBe("approved");
    expect(gate.spentToday()).toBe(4_800);
  });

  it("lets a proposal be used only once", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 4_800));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    expect(gate.confirm(ask.proposalId).status).toBe("approved");
    expect(gate.confirm(ask.proposalId)).toMatchObject({
      status: "denied",
      reason: "proposal_not_found",
    });
    expect(gate.spentToday()).toBe(4_800);
  });

  it("refuses to confirm an id that was never issued", () => {
    expect(makeGate().confirm("made-up")).toMatchObject({
      status: "denied",
      reason: "proposal_not_found",
    });
  });

  it("expires an unanswered question", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 4_800));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    clock += 120_000;
    expect(gate.confirm(ask.proposalId)).toMatchObject({
      status: "denied",
      reason: "proposal_expired",
    });
    expect(gate.spentToday()).toBe(0);
  });

  it("drops a cancelled question", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 4_800));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    expect(gate.cancel(ask.proposalId)).toBe(true);
    expect(gate.confirm(ask.proposalId).status).toBe("denied");
  });

  it("pays the stored payment, not whatever is asked for later", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 4_800));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    gate.request(pay("sunrise-cafe", 9_900));
    gate.confirm(ask.proposalId);
    const entries = gate.history();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.request).toEqual(pay("blue-door-taxi", 4_800));
  });

  it("checks the daily cap again at confirmation time", () => {
    const gate = makeGate();
    const ask = gate.request(pay("blue-door-taxi", 9_000));
    if (ask.status !== "needs_confirmation") throw new Error("expected a question");
    // Another payment lands while the question is open.
    const other = gate.request(pay("blue-door-taxi", 9_500));
    if (other.status !== "needs_confirmation") throw new Error("expected a question");
    expect(gate.confirm(other.proposalId).status).toBe("approved");
    expect(gate.confirm(ask.proposalId)).toMatchObject({
      status: "denied",
      reason: "over_daily_cap",
    });
    expect(gate.spentToday()).toBe(9_500);
  });
});

describe("daily cap", () => {
  it("counts reservations that are still pending", () => {
    const gate = makeGate({ dailyCapCents: 5_000, perPurchaseCapCents: 5_000 });
    expect(gate.request(pay("sunrise-cafe", 2_000)).status).toBe("approved");
    clock += 61_000;
    expect(gate.request(pay("sunrise-cafe", 2_000)).status).toBe("approved");
    clock += 61_000;
    expect(gate.request(pay("sunrise-cafe", 1_001))).toMatchObject({
      status: "denied",
      reason: "over_daily_cap",
    });
  });

  it("does not let two quick requests together beat the cap", () => {
    const gate = makeGate({ dailyCapCents: 3_000, perPurchaseCapCents: 3_000 });
    const a = gate.request(pay("sunrise-cafe", 1_900));
    const b = gate.request(pay("blue-door-taxi", 1_900));
    expect(a.status).toBe("approved");
    expect(b).toMatchObject({ status: "denied", reason: "over_daily_cap" });
  });

  it("allows spending right up to the cap", () => {
    const gate = makeGate({ dailyCapCents: 3_000, perPurchaseCapCents: 3_000 });
    expect(gate.request(pay("sunrise-cafe", 1_500)).status).toBe("approved");
    expect(gate.request(pay("blue-door-taxi", 1_500)).status).toBe("approved");
    expect(gate.remainingToday()).toBe(0);
  });

  it("tells the user how much is left", () => {
    const gate = makeGate({ dailyCapCents: 3_000, perPurchaseCapCents: 3_000 });
    gate.request(pay("sunrise-cafe", 2_000));
    const out = gate.request(pay("blue-door-taxi", 2_000));
    expect(out.status === "denied" && out.message).toContain("$10.00 is left");
  });

  it("starts a new day at local midnight, not UTC midnight", () => {
    const gate = makeGate({ dailyCapCents: 5_000, perPurchaseCapCents: 5_000 });
    // 9:30 pm in New York on Nov 2 (EST) is 02:30 UTC on Nov 3.
    clock = Date.parse("2026-11-03T02:30:00Z");
    expect(gate.request(pay("sunrise-cafe", 2_500)).status).toBe("approved");
    // 11:30 pm New York, same local day though 04:30 UTC.
    clock = Date.parse("2026-11-03T04:30:00Z");
    expect(gate.spentToday()).toBe(2_500);
    // 12:30 am New York on Nov 3.
    clock = Date.parse("2026-11-03T05:30:00Z");
    expect(gate.spentToday()).toBe(0);
  });

  it("frees the budget when a payment fails", () => {
    const gate = makeGate({ dailyCapCents: 3_000, perPurchaseCapCents: 3_000 });
    const out = gate.request(pay("sunrise-cafe", 2_500));
    if (out.status !== "approved") throw new Error("expected approval");
    gate.fail(out.reservationId);
    expect(gate.spentToday()).toBe(0);
    expect(gate.request(pay("sunrise-cafe", 2_500)).status).toBe("approved");
  });
});

describe("duplicates", () => {
  it("asks before repeating the same payment inside the window", () => {
    const gate = makeGate();
    expect(gate.request(pay("sunrise-cafe", 900)).status).toBe("approved");
    clock += 30_000;
    expect(gate.request(pay("sunrise-cafe", 900))).toMatchObject({
      status: "needs_confirmation",
      reasons: ["possible_duplicate"],
    });
  });

  it("does not mind a different amount or a different merchant", () => {
    const gate = makeGate();
    gate.request(pay("sunrise-cafe", 900));
    expect(gate.request(pay("sunrise-cafe", 901)).status).toBe("approved");
    expect(gate.request(pay("blue-door-taxi", 900)).status).toBe("approved");
  });

  it("forgets the payment once the window passes", () => {
    const gate = makeGate();
    gate.request(pay("sunrise-cafe", 900));
    clock += 60_000;
    expect(gate.request(pay("sunrise-cafe", 900)).status).toBe("needs_confirmation");
    clock += 1;
    expect(gate.request(pay("sunrise-cafe", 900)).status).toBe("approved");
  });

  it("ignores a failed payment when looking for duplicates", () => {
    const gate = makeGate();
    const first = gate.request(pay("sunrise-cafe", 900));
    if (first.status !== "approved") throw new Error("expected approval");
    gate.fail(first.reservationId);
    expect(gate.request(pay("sunrise-cafe", 900)).status).toBe("approved");
  });

  it("gives both reasons when a big payment is also a repeat", () => {
    const gate = makeGate();
    const first = gate.request(pay("blue-door-taxi", 4_000));
    if (first.status !== "needs_confirmation") throw new Error("expected a question");
    gate.confirm(first.proposalId);
    const again = gate.request(pay("blue-door-taxi", 4_000));
    expect(again).toMatchObject({
      status: "needs_confirmation",
      reasons: ["above_auto_approve", "possible_duplicate"],
    });
  });
});

describe("settling reservations", () => {
  it("records the PayPal reference when a payment completes", () => {
    const gate = makeGate();
    const out = gate.request(pay("sunrise-cafe", 900));
    if (out.status !== "approved") throw new Error("expected approval");
    gate.complete(out.reservationId, "PAYPAL-ORDER-1");
    expect(gate.history()[0]).toMatchObject({ status: "completed", ref: "PAYPAL-ORDER-1" });
    expect(gate.spentToday()).toBe(900);
  });

  it("will not settle a reservation twice or one that does not exist", () => {
    const gate = makeGate();
    const out = gate.request(pay("sunrise-cafe", 900));
    if (out.status !== "approved") throw new Error("expected approval");
    gate.complete(out.reservationId, "A");
    expect(() => gate.complete(out.reservationId, "B")).toThrow(/already completed/);
    expect(() => gate.fail(out.reservationId)).toThrow(/already completed/);
    expect(() => gate.fail("nope")).toThrow(/unknown reservation/);
  });

  it("hands back copies of the history so callers cannot edit the ledger", () => {
    const gate = makeGate();
    gate.request(pay("sunrise-cafe", 900));
    const [entry] = gate.history();
    if (!entry) throw new Error("expected an entry");
    entry.request.amountCents = 1;
    entry.status = "failed";
    expect(gate.spentToday()).toBe(900);
  });
});

describe("policy validation", () => {
  it.each<[string, Partial<Policy>, RegExp]>([
    ["a bad currency", { currency: "dollars" }, /3-letter/],
    ["an unknown time zone", { timeZone: "Mars/Olympus" }, /time zone|timeZone/i],
    ["a zero cap", { dailyCapCents: 0 }, /dailyCapCents/],
    ["fractional cents", { autoApproveUpToCents: 10.5 }, /autoApproveUpToCents/],
    ["auto-approve above the purchase cap", { autoApproveUpToCents: 10_001 }, /cannot exceed/],
    ["a purchase cap above the daily cap", { perPurchaseCapCents: 15_001 }, /cannot exceed/],
    ["a negative window", { duplicateWindowMs: -1 }, /duplicateWindowMs/],
  ])("rejects %s", (_name, override, message) => {
    expect(() => makeGate(override)).toThrow(message);
  });
});
