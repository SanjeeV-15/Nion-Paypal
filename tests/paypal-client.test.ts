import { describe, expect, it } from "vitest";
import { PayPalClient, PayPalError, toValue } from "../src/paypal/client.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // the sign-in request is form-encoded
  }
}

type Reply = { status?: number; json?: unknown; text?: string } | Error;

function setup(replies: Reply[], overrides: { now?: () => number } = {}) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? parseBody(String(init.body)) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    if (next instanceof Error) throw next;
    const text = next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json));
    const status = next.status ?? 200;
    return new Response(status === 204 ? null : text, { status });
  }) as unknown as typeof fetch;

  const client = new PayPalClient({
    clientId: "id",
    clientSecret: "secret",
    fetch: fakeFetch,
    retryDelayMs: 0,
    ...overrides,
  });
  const api = () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));
  return { client, calls, api, remaining: () => queue.length };
}

const token = (extra: Record<string, unknown> = {}) => ({
  json: { access_token: "tok", expires_in: 32_400, ...extra },
});

const completedOrder = (value = "12.00") => ({
  json: {
    id: "ORDER1",
    status: "COMPLETED",
    purchase_units: [
      { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value, currency_code: "USD" } }] } },
    ],
  },
});

const charge = {
  vaultId: "vault-1",
  amountCents: 1200,
  currency: "USD",
  description: "Sunrise Cafe",
  reference: "res-1",
};

describe("toValue", () => {
  it.each([
    [1, "0.01"],
    [5, "0.05"],
    [100, "1.00"],
    [1200, "12.00"],
    [4805, "48.05"],
    [1_000_001, "10000.01"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(toValue(cents)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (cents) => {
    expect(() => toValue(cents)).toThrow(RangeError);
  });
});

describe("access tokens", () => {
  it("signs in with basic auth and reuses the token", async () => {
    const { client, calls } = setup([token(), completedOrder(), completedOrder()]);
    await client.charge(charge);
    await client.charge({ ...charge, reference: "res-2" });
    const signIns = calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(signIns).toHaveLength(1);
    expect(signIns[0]?.headers.Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(calls.at(-1)?.headers.Authorization).toBe("Bearer tok");
  });

  it("asks for a new token shortly before the old one expires", async () => {
    let now = 0;
    const { client, calls } = setup([token({ expires_in: 600 }), completedOrder(), token(), completedOrder()], {
      now: () => now,
    });
    await client.charge(charge);
    now = 541_000; // less than a minute left on the token
    await client.charge({ ...charge, reference: "res-2" });
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("signs in only once when calls overlap", async () => {
    const { client, calls } = setup([token(), completedOrder(), completedOrder()]);
    await Promise.all([client.charge(charge), client.charge({ ...charge, reference: "res-2" })]);
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("gets a fresh token and retries once after a 401", async () => {
    const { client, calls } = setup([token(), { status: 401, json: { name: "AUTHENTICATION_FAILURE" } }, token(), completedOrder()]);
    const result = await client.charge(charge);
    expect(result.captureId).toBe("CAP1");
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("gives up if PayPal keeps saying 401", async () => {
    const { client } = setup([token(), { status: 401, json: {} }, token(), { status: 401, json: {} }]);
    await expect(client.charge(charge)).rejects.toMatchObject({ status: 401, uncertain: false });
  });

  it("explains refused credentials without echoing them", async () => {
    const { client } = setup([{ status: 401, json: { error: "invalid_client" } }]);
    const err = (await client.charge(charge).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.message).toMatch(/refused our credentials \(invalid_client\)/);
    expect(err.message).not.toContain("secret");
  });
});

describe("charging a saved wallet", () => {
  it("sends the saved wallet, amount and idempotency key", async () => {
    const { client, api } = setup([token(), completedOrder()]);
    await client.charge(charge);
    const [call] = api();
    expect(call?.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(call?.headers["PayPal-Request-Id"]).toBe("res-1");
    expect(call?.body).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        { reference_id: "res-1", description: "Sunrise Cafe", amount: { currency_code: "USD", value: "12.00" } },
      ],
      payment_source: { paypal: { vault_id: "vault-1" } },
    });
  });

  it("returns the capture when PayPal completes the order at once", async () => {
    const { client } = setup([token(), completedOrder()]);
    expect(await client.charge(charge)).toEqual({ orderId: "ORDER1", captureId: "CAP1", status: "COMPLETED" });
  });

  it("captures separately when the order is only approved", async () => {
    const { client, api } = setup([
      token(),
      { json: { id: "ORDER1", status: "APPROVED" } },
      completedOrder(),
    ]);
    const result = await client.charge(charge);
    expect(result.captureId).toBe("CAP1");
    expect(api()[1]?.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1/capture");
    expect(api()[1]?.headers["PayPal-Request-Id"]).toBe("res-1-capture");
  });

  it("refuses an order PayPal left waiting for the buyer", async () => {
    const { client } = setup([token(), { json: { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" } }]);
    await expect(client.charge(charge)).rejects.toMatchObject({ code: "PAYER_ACTION_REQUIRED", uncertain: false });
  });

  it("treats a pending capture as paid", async () => {
    const pending = {
      json: { id: "O", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C", status: "PENDING" }] } }] },
    };
    const { client } = setup([token(), pending]);
    expect((await client.charge(charge)).status).toBe("PENDING");
  });

  it("reports a declined capture as a clean failure", async () => {
    const declined = {
      json: { id: "O", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C", status: "DECLINED" }] } }] },
    };
    const { client } = setup([token(), declined]);
    await expect(client.charge(charge)).rejects.toMatchObject({ code: "DECLINED", uncertain: false });
  });

  it("flags a captured amount that differs from the request as uncertain, never as a clean failure", async () => {
    const { client } = setup([token(), completedOrder("13.00")]);
    await expect(client.charge(charge)).rejects.toMatchObject({ code: "AMOUNT_MISMATCH", uncertain: true });
  });

  it("maps a PayPal 4xx to a definite failure with its reason and debug id", async () => {
    const { client } = setup([
      token(),
      {
        status: 422,
        json: {
          name: "UNPROCESSABLE_ENTITY",
          debug_id: "dbg123",
          details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
        },
      },
    ]);
    const err = (await client.charge(charge).catch((e) => e)) as PayPalError;
    expect(err).toMatchObject({ status: 422, code: "INSTRUMENT_DECLINED", debugId: "dbg123", uncertain: false });
    expect(err.message).toContain("declined");
    expect(err.message).toContain("dbg123");
  });

  it("does not retry a 4xx", async () => {
    const { client, remaining } = setup([token(), { status: 400, json: { name: "INVALID_REQUEST" } }]);
    await expect(client.charge(charge)).rejects.toMatchObject({ status: 400 });
    expect(remaining()).toBe(0);
  });

  it("retries a 5xx with the same idempotency key and succeeds", async () => {
    const { client, api } = setup([token(), { status: 503, json: {} }, completedOrder()]);
    const result = await client.charge(charge);
    expect(result.captureId).toBe("CAP1");
    expect(api().map((c) => c.headers["PayPal-Request-Id"])).toEqual(["res-1", "res-1"]);
  });

  it("calls it uncertain when PayPal keeps failing with 5xx", async () => {
    const { client, api } = setup([token(), { status: 502, json: {} }, { status: 502, json: {} }, { status: 502, json: {} }]);
    await expect(client.charge(charge)).rejects.toMatchObject({ status: 502, uncertain: true });
    expect(api()).toHaveLength(3);
  });

  it("calls it uncertain when the connection drops every time", async () => {
    const drop = new TypeError("fetch failed");
    const { client } = setup([token(), drop, drop, drop]);
    await expect(client.charge(charge)).rejects.toMatchObject({ uncertain: true });
  });

  it("recovers when the connection drops once", async () => {
    const { client } = setup([token(), new TypeError("fetch failed"), completedOrder()]);
    expect((await client.charge(charge)).captureId).toBe("CAP1");
  });

  it("calls an unreadable reply uncertain, because PayPal may have acted", async () => {
    const { client } = setup([token(), { json: { surprise: true } }]);
    await expect(client.charge(charge)).rejects.toMatchObject({ uncertain: true });
  });

  it("rejects a non-positive amount before calling PayPal", async () => {
    const { client, calls } = setup([]);
    await expect(client.charge({ ...charge, amountCents: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("saving a wallet", () => {
  const setupReply = {
    json: {
      id: "SETUP1",
      status: "PAYER_ACTION_REQUIRED",
      customer: { id: "cust1" },
      links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S" }],
    },
  };

  it("asks PayPal for a setup token without charging anything", async () => {
    const { client, api } = setup([token(), setupReply]);
    const out = await client.createSetupToken({
      returnUrl: "http://localhost:4310/api/paypal/return",
      cancelUrl: "http://localhost:4310/api/paypal/cancel",
      description: "Nion Pay",
      requestId: "req-1",
    });
    expect(out).toEqual({
      id: "SETUP1",
      customerId: "cust1",
      approveUrl: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S",
    });
    const [call] = api();
    expect(call?.url).toMatch(/\/v3\/vault\/setup-tokens$/);
    expect(call?.headers["PayPal-Request-Id"]).toBe("req-1");
    expect(JSON.stringify(call?.body)).not.toMatch(/"amount"/);
    expect(call?.body).toMatchObject({
      payment_source: { paypal: { usage_type: "MERCHANT", experience_context: { return_url: "http://localhost:4310/api/paypal/return" } } },
    });
  });

  it.each([
    ["a link to another site", "https://evil.example.com/agreements/approve"],
    ["a lookalike host", "https://paypal.com.evil.example/approve"],
    ["plain http", "http://www.sandbox.paypal.com/approve"],
    ["something that is not a URL", "not a url"],
  ])("will not send the buyer to %s", async (_name, href) => {
    const reply = { json: { id: "S", links: [{ rel: "approve", href }] } };
    const { client } = setup([token(), reply]);
    await expect(
      client.createSetupToken({ returnUrl: "http://x/r", cancelUrl: "http://x/c", description: "d", requestId: "r" }),
    ).rejects.toBeInstanceOf(PayPalError);
  });

  it("rejects a setup token that came back with no approval link", async () => {
    const { client } = setup([token(), { json: { id: "S", links: [] } }]);
    await expect(
      client.createSetupToken({ returnUrl: "http://x/r", cancelUrl: "http://x/c", description: "d", requestId: "r" }),
    ).rejects.toBeInstanceOf(PayPalError);
  });

  it("turns an approved setup token into a saved wallet", async () => {
    const reply = {
      json: { id: "VAULT1", customer: { id: "cust1" }, payment_source: { paypal: { email_address: "buyer@example.com" } } },
    };
    const { client, api } = setup([token(), reply]);
    const wallet = await client.createSavedWallet("SETUP1", "req-2");
    expect(wallet).toEqual({ vaultId: "VAULT1", customerId: "cust1", email: "buyer@example.com" });
    expect(api()[0]?.body).toEqual({ payment_source: { token: { id: "SETUP1", type: "SETUP_TOKEN" } } });
  });

  it("deletes a saved wallet and accepts PayPal's empty reply", async () => {
    const { client, api } = setup([token(), { status: 204 }]);
    await client.deleteSavedWallet("VAULT/1");
    expect(api()[0]).toMatchObject({ method: "DELETE" });
    expect(api()[0]?.url).toMatch(/payment-tokens\/VAULT%2F1$/);
  });
});

describe("refunds", () => {
  it("refunds a capture with an idempotency key", async () => {
    const { client, api } = setup([token(), { json: { id: "REF1", status: "COMPLETED" } }]);
    expect(await client.refund("CAP1", "ref-req")).toEqual({ id: "REF1", status: "COMPLETED" });
    expect(api()[0]?.url).toMatch(/\/v2\/payments\/captures\/CAP1\/refund$/);
    expect(api()[0]?.headers["PayPal-Request-Id"]).toBe("ref-req");
  });
});
