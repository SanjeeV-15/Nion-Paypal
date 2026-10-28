import { afterEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../src/app.js";
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
