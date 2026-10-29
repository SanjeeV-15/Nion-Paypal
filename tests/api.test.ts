import { afterEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../src/app.js";
import { createClaudeChat, type AnthropicLike } from "../src/agent/claude.js";
import { ChatLimiter } from "../src/limiter.js";
import { startApp as start, stopApps } from "./helpers.js";
import type { WalletSnapshot } from "../src/wallet.js";

afterEach(stopApps);

const chat = (message: string) => ({ message });

describe("sessions over HTTP", () => {
  it("sets an HttpOnly cookie and keeps one wallet per visitor", async () => {
    const a = await start();
    const first = await a.call("/api/wallet");
    expect(first.headers.get("set-cookie")).toMatch(/nion_sid=[0-9a-f]{32}; .*HttpOnly.*SameSite=Lax/i);

    await a.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    const mine = (await a.call("/api/wallet")).json.wallet as WalletSnapshot;
    expect(mine.spentCents).toBe(1200);

    const stranger = await start();
    const theirs = (await stranger.call("/api/wallet")).json.wallet as WalletSnapshot;
    expect(theirs.spentCents).toBe(0);
  });
});

describe("request hygiene", () => {
  it("rejects posts that are not JSON", async () => {
    const { call } = await start();
    const res = await call("/api/chat", "pay $12 to Sunrise Cafe", {
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.status).toBe(415);
  });

  it("rejects malformed JSON, empty and oversized messages", async () => {
    const { call } = await start();
    expect((await call("/api/chat", undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" })).status).toBe(400);
    expect((await call("/api/chat", chat("   "))).status).toBe(400);
    expect((await call("/api/chat", chat("x".repeat(501)))).status).toBe(400);
    expect((await call("/api/chat", { message: 42 })).status).toBe(400);
  });

  it("does not advertise Express", async () => {
    const { call } = await start();
    expect((await call("/api/health")).headers.get("x-powered-by")).toBeNull();
  });
});

describe("paying in demo mode", () => {
  it("pays a small amount straight away and records it", async () => {
    const { call } = await start();
    const res = await call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/Cleared to pay \$12\.00 to Sunrise Cafe/);
    expect(res.json.reply).toMatch(/demo/i);
    const wallet = res.json.wallet as WalletSnapshot;
    expect(wallet.mode).toBe("demo");
    expect(wallet.spentCents).toBe(1200);
    expect(wallet.activity[0]).toMatchObject({ merchant: "Sunrise Cafe", status: "completed" });
    expect(wallet.pending).toBeNull();
  });

  it("asks before a bigger payment and pays only after a spoken yes", async () => {
    const { call } = await start();
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    expect(ask.json.reply).toMatch(/Pay \$48\.00 to Blue Door Taxi\?/);
    expect(ask.json.wallet.pending).toMatchObject({
      merchant: "Blue Door Taxi",
      amountCents: 4800,
      reasons: ["above_auto_approve"],
    });
    expect(ask.json.wallet.spentCents).toBe(0);

    const yes = await call("/api/chat", chat("Yes."));
    expect(yes.json.reply).toMatch(/Cleared to pay \$48\.00/);
    expect(yes.json.wallet.spentCents).toBe(4800);
    expect(yes.json.wallet.pending).toBeNull();
  });

  it("does not pay on a yes that carries extra words", async () => {
    const { call } = await start();
    await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const res = await call("/api/chat", chat("yes but make it five dollars"));
    expect(res.json.wallet.spentCents).toBe(0);
    expect(res.json.wallet.pending).not.toBeNull();
  });

  it("cancels on a spoken no", async () => {
    const { call } = await start();
    await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const res = await call("/api/chat", chat("no"));
    expect(res.json.reply).toMatch(/cancelled/);
    expect(res.json.wallet.spentCents).toBe(0);
    expect(res.json.wallet.pending).toBeNull();
  });

  it("replaces an open question when a new payment is asked for", async () => {
    const { call } = await start();
    const first = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const second = await call("/api/chat", chat("pay $60 to Harbor Tours"));
    expect(second.json.wallet.pending.proposalId).not.toBe(first.json.wallet.pending.proposalId);
    expect(second.json.wallet.pending.merchant).toBe("Harbor Tours");
    const yes = await call("/api/chat", chat("yes"));
    expect(yes.json.wallet.spentCents).toBe(6000);
  });

  it("refuses payments that break a hard limit, however they are asked", async () => {
    const { call } = await start();
    expect((await call("/api/chat", chat("pay $101 to Blue Door Taxi"))).json.reply).toMatch(/limit for one payment/);
    expect((await call("/api/chat", chat("pay $5 to Nobody In Particular"))).json.reply).toMatch(/Who should I pay/);
    const res = await call("/api/chat", chat("pay $0.00 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/positive amount/);
    expect(res.json.wallet.spentCents).toBe(0);
  });

  it("enforces the daily limit across payments", async () => {
    const { call } = await start();
    await call("/api/chat", chat("pay $90 to Blue Door Taxi"));
    await call("/api/chat", chat("yes"));

    const over = await call("/api/chat", chat("pay $90 to Harbor Tours"));
    expect(over.json.reply).toMatch(/daily limit.*\$60\.00 is left/);
    expect(over.json.wallet.pending).toBeNull();

    await call("/api/chat", chat("pay $60 to Sunrise Cafe"));
    const full = await call("/api/chat", chat("yes"));
    expect(full.json.wallet.spentCents).toBe(15_000);
    expect(full.json.wallet.remainingCents).toBe(0);

    const none = await call("/api/chat", chat("pay $1 to Sunrise Cafe"));
    expect(none.json.reply).toMatch(/daily limit/);
    expect(none.json.wallet.spentCents).toBe(15_000);
  });
});

describe("confirm and cancel buttons", () => {
  it("confirms the open question without going through the chat handler", async () => {
    let chatCalls = 0;
    const { call } = await start({
      chat: async (session, message, executor) => {
        chatCalls++;
        const { demoChat } = await import("../src/chat/demo.js");
        return demoChat(session, message, executor);
      },
    });
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const proposalId = ask.json.wallet.pending.proposalId as string;
    expect(chatCalls).toBe(1);

    const res = await call("/api/confirm", { proposalId });
    expect(res.status).toBe(200);
    expect(res.json.wallet.spentCents).toBe(4800);
    expect(chatCalls).toBe(1);
  });

  it("refuses a stale or invented proposal id", async () => {
    const { call } = await start();
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const bad = await call("/api/confirm", { proposalId: "made-up" });
    expect(bad.status).toBe(409);
    expect(bad.json.wallet.spentCents).toBe(0);
    expect(bad.json.wallet.pending.proposalId).toBe(ask.json.wallet.pending.proposalId);
  });

  it("cannot confirm one visitor's question from another visitor's session", async () => {
    const alice = await start();
    const ask = await alice.call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const bob = await start();
    const res = await bob.call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    expect(res.status).toBe(409);
    expect(((await alice.call("/api/wallet")).json.wallet as WalletSnapshot).spentCents).toBe(0);
  });

  it("cancels with the button", async () => {
    const { call } = await start();
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const res = await call("/api/cancel", { proposalId: ask.json.wallet.pending.proposalId });
    expect(res.json.wallet.pending).toBeNull();
    expect(res.json.wallet.spentCents).toBe(0);
  });

  it("will not confirm twice", async () => {
    const { call } = await start();
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const proposalId = ask.json.wallet.pending.proposalId as string;
    expect((await call("/api/confirm", { proposalId })).status).toBe(200);
    expect((await call("/api/confirm", { proposalId })).status).toBe(409);
    expect(((await call("/api/wallet")).json.wallet as WalletSnapshot).spentCents).toBe(4800);
  });
});

describe("a payment that fails", () => {
  it("gives the money back and says nothing was charged", async () => {
    const { call } = await start({
      executor: {
        ready: () => null,
        receipt: (summary) => `Paid ${summary}.`,
        pay: async () => {
          throw new Error("PayPal said no");
        },
      },
    });
    const res = await call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    expect(res.json.reply).toMatch(/nothing was charged/);
    expect(res.json.wallet.spentCents).toBe(0);
    expect(res.json.wallet.activity[0]).toMatchObject({ status: "failed" });
  });
});

describe("bills over HTTP", () => {
  const bill = (w: WalletSnapshot, id: string) => w.bills.find((b) => b.id === id);

  it("are part of every visitor's wallet, with due dates", async () => {
    const { call } = await start();
    const wallet = (await call("/api/wallet")).json.wallet as WalletSnapshot;
    expect(wallet.bills.map((b) => b.id)).toEqual(["phone", "credit-card", "electric", "rent"]);
    expect(bill(wallet, "phone")).toMatchObject({
      name: "Phone plan",
      payee: "Skyline Mobile",
      amountCents: 4250,
      daysUntilDue: 3,
      status: "due",
    });
    expect(wallet.merchants.map((m) => m.id)).not.toContain("skyline-mobile");
  });

  it("are paid from the Pay button without the model, after the user confirms", async () => {
    const { call } = await start();
    const ask = await call("/api/bills/pay", { billId: "phone" });
    expect(ask.status).toBe(200);
    expect(ask.json.reply).toMatch(/Pay \$42\.50 to Skyline Mobile\?/);
    expect(ask.json.wallet.pending).toMatchObject({ merchant: "Skyline Mobile", billName: "Phone plan", amountCents: 4250 });
    expect(bill(ask.json.wallet, "phone")?.status).toBe("due");

    const done = await call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    expect(done.json.wallet.spentCents).toBe(4250);
    expect(bill(done.json.wallet, "phone")?.status).toBe("paid");
    expect(done.json.wallet.activity[0]).toMatchObject({ merchant: "Skyline Mobile", status: "completed" });
  });

  it("will not pay the same bill twice", async () => {
    const { call } = await start();
    const ask = await call("/api/bills/pay", { billId: "electric" });
    await call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    const again = await call("/api/bills/pay", { billId: "electric" });
    expect(again.json.reply).toMatch(/already paid/);
    expect(again.json.wallet.spentCents).toBe(3820);
  });

  it("refuses the rent because of the limit, and keeps it due", async () => {
    const { call } = await start();
    const out = await call("/api/bills/pay", { billId: "rent" });
    expect(out.json.reply).toMatch(/limit for one payment/);
    expect(bill(out.json.wallet, "rent")?.status).toBe("due");
    expect(out.json.wallet.spentCents).toBe(0);
  });

  it.each([["an unknown bill", { billId: "mortgage" }], ["no bill", {}], ["a non-string bill", { billId: 5 }]])(
    "reject %s",
    async (_name, body) => {
      const { call } = await start();
      expect((await call("/api/bills/pay", body)).status).toBe(404);
    },
  );

  it("belong to one visitor: paying yours does not mark someone else's", async () => {
    const a = await start();
    const b = await start();
    const ask = await a.call("/api/bills/pay", { billId: "phone" });
    await a.call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    expect(bill((await b.call("/api/wallet")).json.wallet, "phone")?.status).toBe("due");
  });

  it("can be asked about and paid in the simple chat, too", async () => {
    const { call } = await start();
    const list = await call("/api/chat", chat("what bills are due?"));
    expect(list.json.reply).toMatch(/Phone plan, \$42\.50, due in 3 days\./);
    const ask = await call("/api/chat", chat("pay my phone bill"));
    expect(ask.json.wallet.pending).toMatchObject({ billName: "Phone plan" });
    const done = await call("/api/chat", chat("yes"));
    expect(bill(done.json.wallet, "phone")?.status).toBe("paid");
    expect((await call("/api/chat", chat("what bills are due?"))).json.reply).toMatch(/Phone plan, \$42\.50, paid\./);
  });
});

describe("setting your own limits", () => {
  const set = (autoApproveUpToCents: number, perPurchaseCapCents: number, dailyCapCents: number) => ({
    autoApproveUpToCents,
    perPurchaseCapCents,
    dailyCapCents,
  });

  it("changes the limits and the wallet shows them", async () => {
    const { call } = await start();
    const out = await call("/api/limits", set(5_000, 20_000, 30_000));
    expect(out.status).toBe(200);
    expect(out.json.wallet.limits).toMatchObject({ autoApproveUpToCents: 5_000, perPurchaseCapCents: 20_000, dailyCapCents: 30_000 });
    expect(out.json.wallet.remainingCents).toBe(30_000);
    expect(out.json.wallet.ceilings).toEqual({ perPurchaseCapCents: 100_000, dailyCapCents: 200_000 });
  });

  it("makes the next payment follow the new limits", async () => {
    const { call } = await start();
    await call("/api/limits", set(5_000, 20_000, 30_000));
    const paid = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    expect(paid.json.reply).toMatch(/Cleared to pay \$48\.00/); // no longer over the ask-first line
    expect(paid.json.wallet.pending).toBeNull();
  });

  it("lets the rent be paid once the limit is raised to cover it", async () => {
    const { call } = await start();
    expect((await call("/api/bills/pay", { billId: "rent" })).json.reply).toMatch(/limit for one payment/);
    await call("/api/limits", set(2_500, 100_000, 200_000));
    const ask = await call("/api/bills/pay", { billId: "rent" });
    expect(ask.json.wallet.pending).toMatchObject({ billName: "Rent", amountCents: 90_000 });
    const done = await call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    expect(done.json.wallet.bills.find((b: { id: string }) => b.id === "rent").status).toBe("paid");
  });

  it.each([
    ["limits past the ceiling", set(2_500, 100_001, 150_000), /at most \$1,000\.00/],
    ["ask-first above the payment limit", set(30_000, 10_000, 15_000), /without asking/],
    ["a zero limit", set(0, 10_000, 15_000), /above zero/],
  ])("refuses %s with a reason, and changes nothing", async (_name, body, message) => {
    const { call } = await start();
    const out = await call("/api/limits", body);
    expect(out.status).toBe(400);
    expect(out.json.error).toMatch(message);
    expect(out.json.wallet.limits).toMatchObject({ autoApproveUpToCents: 2_500, perPurchaseCapCents: 10_000, dailyCapCents: 15_000 });
  });

  it.each([
    ["missing limits", {}],
    ["limits as text", { autoApproveUpToCents: "25", perPurchaseCapCents: "100", dailyCapCents: "150" }],
    ["only some limits", { autoApproveUpToCents: 2_500 }],
  ])("rejects %s", async (_name, body) => {
    const { call } = await start();
    expect((await call("/api/limits", body)).status).toBe(400);
  });

  it("belong to one visitor only", async () => {
    const a = await start();
    const b = await start();
    await a.call("/api/limits", set(5_000, 20_000, 30_000));
    expect(((await b.call("/api/wallet")).json.wallet as WalletSnapshot).limits.dailyCapCents).toBe(15_000);
  });

  it("cannot be changed through the chat, even if asked directly", async () => {
    const { call } = await start();
    await call("/api/chat", chat("set my daily limit to 2000 dollars"));
    expect(((await call("/api/wallet")).json.wallet as WalletSnapshot).limits.dailyCapCents).toBe(15_000);
  });
});

describe("starting the demo over", () => {
  it("clears payments, bills, limits and any open question", async () => {
    const { call } = await start();
    await call("/api/limits", { autoApproveUpToCents: 5_000, perPurchaseCapCents: 20_000, dailyCapCents: 30_000 });
    await call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    await call("/api/bills/pay", { billId: "phone" }); // $42.50 is under the new $50 ask-first line, so it pays
    const out = await call("/api/reset", {});
    expect(out.status).toBe(200);
    const w = out.json.wallet as WalletSnapshot;
    expect(w.spentCents).toBe(0);
    expect(w.activity).toEqual([]);
    expect(w.pending).toBeNull();
    expect(w.limits).toMatchObject({ autoApproveUpToCents: 2_500, perPurchaseCapCents: 10_000, dailyCapCents: 15_000 });
    expect(w.bills.every((b) => b.status === "due")).toBe(true);
  });

  it("drops a question that was waiting, so a late yes pays nothing", async () => {
    const { call } = await start();
    const ask = await call("/api/chat", chat("pay $48 to Blue Door Taxi"));
    const proposalId = ask.json.wallet.pending.proposalId;
    await call("/api/reset", {});
    expect((await call("/api/confirm", { proposalId })).status).toBe(409);
    expect(((await call("/api/wallet")).json.wallet as WalletSnapshot).spentCents).toBe(0);
  });

  it("only resets the visitor who asked", async () => {
    const a = await start();
    const b = await start();
    await a.call("/api/chat", chat("pay $12 to Sunrise Cafe"));
    await b.call("/api/chat", chat("pay $20 to Sunrise Cafe"));
    await a.call("/api/reset", {});
    expect(((await a.call("/api/wallet")).json.wallet as WalletSnapshot).spentCents).toBe(0);
    expect(((await b.call("/api/wallet")).json.wallet as WalletSnapshot).spentCents).toBe(2_000);
  });

  it("needs a JSON request, like every other action that changes things", async () => {
    const { call } = await start();
    const res = await call("/api/reset", "x", { headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(415);
  });
});

describe("what the model remembers after a button", () => {
  /** A model that asks to pay on the first turn and then just chats, recording what it was shown. */
  function modelThatPays() {
    const seen: { messages: { role: string; content: unknown }[]; system: unknown }[] = [];
    let turns = 0;
    const client = {
      beta: {
        messages: {
          create: async (params: { messages: { role: string; content: unknown }[]; system: unknown }) => {
            seen.push(structuredClone({ messages: params.messages, system: params.system }));
            turns++;
            if (turns === 1) {
              return {
                stop_reason: "tool_use",
                content: [{ type: "tool_use", id: "t1", name: "pay", input: { merchant_id: "blue-door-taxi", amount_usd: 48 } }],
              };
            }
            return { stop_reason: "end_turn", content: [{ type: "text", text: "Anything else?" }] };
          },
        },
      },
    } as unknown as AnthropicLike;
    return { seen, chat: createClaudeChat({ client, model: "claude-sonnet-5-5", limiter: new ChatLimiter({ perVisitorPerHour: 50, perDay: 500 }) }) };
  }

  it("includes the confirmed payment, so it does not think the question is still open", async () => {
    const m = modelThatPays();
    const { call } = await start({ chat: m.chat });
    const ask = await call("/api/chat", chat("pay forty-eight dollars to Blue Door Taxi"));
    expect(ask.json.wallet.pending).not.toBeNull();

    await call("/api/confirm", { proposalId: ask.json.wallet.pending.proposalId });
    await call("/api/chat", chat("can you increase my limit"));

    const shown = m.seen.at(-1)!.messages.map((x) => `${x.role}: ${typeof x.content === "string" ? x.content : "[blocks]"}`);
    const asked = shown.findIndex((l) => /Say yes to confirm/.test(l));
    const paid = shown.findIndex((l) => /Cleared to pay \$48\.00 to Blue Door Taxi/.test(l));
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(paid).toBeGreaterThan(asked);
    expect(shown.at(-1)).toBe("user: can you increase my limit");
  });

  it("records a cancel, and a bill Pay button, the same way", async () => {
    const m = modelThatPays();
    const { call } = await start({ chat: m.chat });
    const ask = await call("/api/chat", chat("pay forty-eight dollars to Blue Door Taxi"));
    await call("/api/cancel", { proposalId: ask.json.wallet.pending.proposalId });
    const bill = await call("/api/bills/pay", { billId: "rent" });
    await call("/api/chat", chat("hello"));

    const shown = m.seen.at(-1)!.messages.map((x) => (typeof x.content === "string" ? x.content : "[blocks]"));
    expect(shown).toContain("I tapped Cancel.");
    expect(shown).toContain("I tapped Pay on my rent bill.");
    expect(shown).toContain(bill.json.reply);
  });
});
