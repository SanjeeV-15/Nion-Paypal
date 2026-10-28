import { describe, expect, it } from "vitest";
import { ChatLimiter } from "../src/limiter.js";

const HOUR = 60 * 60 * 1000;

function make(perVisitorPerHour = 3, perDay = 5) {
  let now = Date.parse("2026-11-02T12:00:00Z");
  const limiter = new ChatLimiter({ perVisitorPerHour, perDay, now: () => now });
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe("ChatLimiter", () => {
  it("lets a visitor ask up to the hourly cap and then says no", () => {
    const { limiter } = make();
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: false, reason: "visitor" });
  });

  it("keeps visitors apart", () => {
    const { limiter } = make(1, 10);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
    expect(limiter.take("b").ok).toBe(true);
  });

  it("gives the allowance back as the hour rolls on", () => {
    const { limiter, advance } = make(2, 100);
    limiter.take("a");
    advance(30 * 60 * 1000);
    limiter.take("a");
    expect(limiter.take("a").ok).toBe(false);
    advance(31 * 60 * 1000); // the first one is now over an hour old
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("stops everyone at the daily ceiling", () => {
    const { limiter } = make(10, 3);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(true);
    expect(limiter.take("c").ok).toBe(true);
    expect(limiter.take("d")).toEqual({ ok: false, reason: "day" });
  });

  it("starts a fresh day at midnight UTC", () => {
    const { limiter, advance } = make(10, 1);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(false);
    advance(12 * HOUR + 1); // past midnight UTC
    expect(limiter.take("b").ok).toBe(true);
  });

  it("does not count a refused request against anyone", () => {
    const { limiter } = make(1, 2);
    limiter.take("a");
    limiter.take("a"); // refused for the visitor cap
    expect(limiter.take("b").ok).toBe(true); // the day still has room: only 2 were used
  });
});
