import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { publicBaseUrl } from "../src/config.js";
import { WindowLimiter } from "../src/limiter.js";
import { SessionStore } from "../src/sessions.js";
import { defaultPolicy } from "../src/config.js";
import { SpendingGate } from "../src/limits/gate.js";
import { startApp, stopApps } from "./helpers.js";

afterEach(stopApps);

describe("publicBaseUrl", () => {
  it("prefers an explicit setting, then Render's own URL, then localhost", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://a.example", RENDER_EXTERNAL_URL: "https://b.onrender.com" }, 4310)).toBe("https://a.example");
    expect(publicBaseUrl({ RENDER_EXTERNAL_URL: "https://b.onrender.com" }, 4310)).toBe("https://b.onrender.com");
    expect(publicBaseUrl({}, 4310)).toBe("http://localhost:4310");
  });

  it("treats empty values as unset", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "", RENDER_EXTERNAL_URL: "" }, 4310)).toBe("http://localhost:4310");
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "", RENDER_EXTERNAL_URL: "https://b.onrender.com" }, 4310)).toBe("https://b.onrender.com");
  });
});

describe("security headers", () => {
  it("are on pages and API replies alike", async () => {
    const { call } = await startApp();
    for (const path of ["/", "/api/health", "/api/wallet"]) {
      const { headers } = await call(path);
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("x-frame-options")).toBe("DENY");
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      expect(headers.get("permissions-policy")).toContain("microphone=(self)");
      expect(headers.get("content-security-policy")).toContain("default-src 'self'");
    }
  });

  it("lets nothing run or load from another site", async () => {
    const csp = (await (await startApp()).call("/")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it("asks browsers to stay on https only when the request came in over https", async () => {
    const { call } = await startApp();
    expect((await call("/api/health")).headers.get("strict-transport-security")).toBeNull();
    const behindProxy = await call("/api/health", undefined, { headers: { "X-Forwarded-Proto": "https" } });
    expect(behindProxy.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("does not advertise Express", async () => {
    expect((await (await startApp()).call("/")).headers.get("x-powered-by")).toBeNull();
  });
});

describe("the page itself follows the content security policy", () => {
  it("has no inline scripts, inline styles or style attributes", () => {
    const html = readFileSync("public/index.html", "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    for (const file of ["public/app.js", "public/voice.js", "public/speech-logic.js"]) {
      const js = readFileSync(file, "utf8");
      expect(js, file).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });
});

describe("the page's styles", () => {
  it("let the hidden attribute win over any display rule", () => {
    expect(readFileSync("public/styles.css", "utf8")).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  });
});

describe("new visitors", () => {
  it("are limited per network, so nobody can flood the session store", async () => {
    const { base } = await startApp({ newVisitorsPerMinute: 3 });
    // A request with no cookie is a brand-new visitor each time.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${base}/api/wallet`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("say why, in words a person can read", async () => {
    const { base } = await startApp({ newVisitorsPerMinute: 1 });
    await fetch(`${base}/api/wallet`);
    const refused = await fetch(`${base}/api/wallet`);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toMatch(/Too many new visitors/);
  });

  it("do not stop a returning visitor, or the health check", async () => {
    const { call, base } = await startApp({ newVisitorsPerMinute: 1 });
    expect((await call("/api/wallet")).status).toBe(200); // the one allowed new visitor
    for (let i = 0; i < 5; i++) expect((await call("/api/wallet")).status).toBe(200); // same cookie
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});

describe("WindowLimiter", () => {
  function make(max = 2, windowMs = 1000) {
    let now = 0;
    return { limiter: new WindowLimiter({ max, windowMs, now: () => now }), advance: (ms: number) => (now += ms) };
  }

  it("allows up to the limit and then refuses", () => {
    const { limiter } = make();
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
  });

  it("keeps keys apart", () => {
    const { limiter } = make(1);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("forgets events once the window has passed", () => {
    const { limiter, advance } = make(1, 1000);
    expect(limiter.take("a")).toBe(true);
    advance(999);
    expect(limiter.take("a")).toBe(false);
    advance(2);
    expect(limiter.take("a")).toBe(true);
  });
});

describe("SessionStore.has", () => {
  it("knows live sessions only, and does not create or refresh them", () => {
    let now = 0;
    const store = new SessionStore({
      createGate: () => new SpendingGate(defaultPolicy({})),
      ttlMs: 1000,
      max: 5,
      now: () => now,
    });
    const { session } = store.get(undefined);
    expect(store.has(session.id)).toBe(true);
    expect(store.has("nope")).toBe(false);
    expect(store.has(undefined)).toBe(false);
    expect(store.size).toBe(1);
    now = 1001;
    expect(store.has(session.id)).toBe(false);
  });
});

describe("secrets stay out of the repository", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

  it("never tracks a real .env file or the smoke-test data", () => {
    expect(tracked).not.toContain(".env");
    expect(tracked.filter((f) => f.startsWith("data/"))).toEqual([]);
  });

  it("holds no Anthropic key or long secret-looking value in any tracked file", () => {
    for (const file of tracked) {
      if (/\.(png|jpg|ico|woff2?)$/.test(file) || file === "package-lock.json") continue;
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}/);
      expect(text, file).not.toMatch(/PAYPAL_CLIENT_SECRET\s*=\s*\S{20,}/);
    }
  });

  it("marks every secret in render.yaml as asked-for rather than written down", () => {
    const yaml = readFileSync("render.yaml", "utf8");
    for (const key of ["ANTHROPIC_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
      expect(yaml).toMatch(new RegExp(`key: ${key}\\n\\s+sync: false`));
    }
    expect(yaml).toMatch(/key: PAYPAL_ENV\n\s+value: sandbox/);
  });
});
