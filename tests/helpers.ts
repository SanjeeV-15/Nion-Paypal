import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, type AppOptions } from "../src/app.js";
import { defaultPolicy } from "../src/config.js";
import { SpendingGate } from "../src/limits/gate.js";
import { payeeName } from "../src/merchants.js";
import { sampleBills } from "../src/bills.js";
import type { Session } from "../src/sessions.js";

export interface TestServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Starts the app on loopback only, and waits until it is really listening.
 * A wildcard bind on a random port can be shadowed by an unrelated local
 * service on the same port, which made these tests fail about once in 300 runs.
 */
export function listen(app: Express): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const apps: TestServer[] = [];

/** Starts the real app and returns a tiny browser that keeps its session cookie. */
export async function startApp(options?: AppOptions) {
  const server = await listen(createApp(options));
  apps.push(server);
  const { base } = server;

  let cookie = "";
  async function call(path: string, body?: unknown, init: RequestInit = {}) {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: parseJson(text) };
  }
  return { call, base };
}

export async function stopApps(): Promise<void> {
  await Promise.all(apps.splice(0).map((s) => s.close()));
}

// Redirects carry a plain-text body, so anything that is not JSON becomes null.
function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** A fresh visitor with a default wallet, for tests that skip HTTP. */
export function makeSession(): Session {
  return {
    id: "s1",
    gate: new SpendingGate(defaultPolicy({}), { merchantName: payeeName }),
    pending: null,
    paypal: null,
    paypalSetupId: null,
    bills: sampleBills(Date.now()),
    history: [],
    lastSeen: 0,
  };
}
