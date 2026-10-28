import { describe, expect, it } from "vitest";
import { SpendingGate } from "../src/limits/gate.js";
import { defaultPolicy } from "../src/config.js";
import { SessionStore } from "../src/sessions.js";

function makeStore(max = 3, ttlMs = 1000) {
  let now = 0;
  const store = new SessionStore({
    createGate: () => new SpendingGate(defaultPolicy({})),
    ttlMs,
    max,
    now: () => now,
  });
  return { store, advance: (ms: number) => (now += ms) };
}

describe("SessionStore", () => {
  it("gives a new visitor a fresh wallet and remembers it", () => {
    const { store } = makeStore();
    const first = store.get(undefined);
    expect(first.created).toBe(true);
    const again = store.get(first.session.id);
    expect(again.created).toBe(false);
    expect(again.session).toBe(first.session);
  });

  it("keeps wallets separate between visitors", () => {
    const { store } = makeStore();
    const a = store.get(undefined).session;
    const b = store.get(undefined).session;
    a.gate.request({ merchantId: "sunrise-cafe", amountCents: 900, currency: "USD" });
    expect(a.gate.spentToday()).toBe(900);
    expect(b.gate.spentToday()).toBe(0);
  });

  it("does not trust an id it never issued", () => {
    const { store } = makeStore();
    const out = store.get("not-a-real-id");
    expect(out.created).toBe(true);
    expect(out.session.id).not.toBe("not-a-real-id");
  });

  it("forgets visitors after the idle time", () => {
    const { store, advance } = makeStore(3, 1000);
    const { session } = store.get(undefined);
    advance(1001);
    const next = store.get(session.id);
    expect(next.created).toBe(true);
    expect(next.session.id).not.toBe(session.id);
  });

  it("keeps an active visitor alive", () => {
    const { store, advance } = makeStore(3, 1000);
    const { session } = store.get(undefined);
    advance(800);
    store.get(session.id);
    advance(800);
    expect(store.get(session.id).created).toBe(false);
  });

  it("drops the least recently used visitor when full", () => {
    const { store } = makeStore(2);
    const a = store.get(undefined).session;
    const b = store.get(undefined).session;
    store.get(a.id); // a is now newer than b
    store.get(undefined); // evicts b
    expect(store.size).toBe(2);
    expect(store.get(a.id).created).toBe(false);
    expect(store.get(b.id).created).toBe(true);
  });
});
