import { z } from "zod";

const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const TOKEN_MARGIN_MS = 60_000;
const MAX_ATTEMPTS = 3;

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Only for tests; real use is always the sandbox. */
  baseUrl?: string;
}

export interface PayPalErrorInfo {
  status?: number;
  /** PayPal's error name, e.g. INSTRUMENT_DECLINED. */
  code?: string;
  debugId?: string;
  /** True when we cannot tell whether PayPal acted on the request. */
  uncertain: boolean;
  cause?: unknown;
}

export class PayPalError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly debugId?: string;
  readonly uncertain: boolean;

  constructor(message: string, info: PayPalErrorInfo) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "PayPalError";
    this.status = info.status;
    this.code = info.code;
    this.debugId = info.debugId;
    this.uncertain = info.uncertain;
  }
}

const link = z.object({ href: z.string(), rel: z.string() });

const setupTokenSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  customer: z.object({ id: z.string().optional() }).optional(),
  links: z.array(link).default([]),
});

const paymentTokenSchema = z.object({
  id: z.string(),
  customer: z.object({ id: z.string().optional() }).optional(),
  payment_source: z
    .object({ paypal: z.object({ email_address: z.string().optional() }).optional() })
    .optional(),
});

const capture = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.object({ value: z.string(), currency_code: z.string() }).optional(),
});

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z
    .array(z.object({ payments: z.object({ captures: z.array(capture).optional() }).optional() }))
    .optional(),
});

const refundSchema = z.object({ id: z.string(), status: z.string() });

export interface SetupToken {
  id: string;
  customerId?: string;
  approveUrl: string;
}

export interface SavedWallet {
  vaultId: string;
  customerId?: string;
  email?: string;
}

export interface Charge {
  orderId: string;
  captureId: string;
  status: string;
}

export interface ChargeRequest {
  vaultId: string;
  amountCents: number;
  currency: string;
  description: string;
  /** Our own id for the payment; also the idempotency key. */
  reference: string;
}

/** Statuses that mean the money was taken or is on its way. */
const PAID = new Set(["COMPLETED", "PENDING"]);

export class PayPalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private cached: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly config: PayPalConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
    this.baseUrl = config.baseUrl ?? SANDBOX_URL;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.retryDelayMs = config.retryDelayMs ?? 300;
  }

  /** Asks PayPal to send the buyer to its approval page. Nothing is charged. */
  async createSetupToken(args: {
    returnUrl: string;
    cancelUrl: string;
    description: string;
    requestId: string;
  }): Promise<SetupToken> {
    const json = await this.call("POST", "/v3/vault/setup-tokens", {
      requestId: args.requestId,
      body: {
        payment_source: {
          paypal: {
            description: args.description.slice(0, 127),
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: {
              shipping_preference: "NO_SHIPPING",
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              brand_name: "Nion Pay",
              locale: "en-US",
              return_url: args.returnUrl,
              cancel_url: args.cancelUrl,
            },
          },
        },
      },
    });
    const parsed = parse(setupTokenSchema, json, "setup token");
    const approve = parsed.links.find((l) => l.rel === "approve" || l.rel === "payer-action");
    if (!approve) throw malformed("setup token had no approval link");
    return { id: parsed.id, customerId: parsed.customer?.id, approveUrl: checkedPayPalUrl(approve.href) };
  }

  /** After the buyer approved, turns the setup token into a saved wallet. */
  async createSavedWallet(setupTokenId: string, requestId: string): Promise<SavedWallet> {
    const json = await this.call("POST", "/v3/vault/payment-tokens", {
      requestId,
      body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    });
    const parsed = parse(paymentTokenSchema, json, "payment token");
    return {
      vaultId: parsed.id,
      customerId: parsed.customer?.id,
      email: parsed.payment_source?.paypal?.email_address,
    };
  }

  async deleteSavedWallet(vaultId: string): Promise<void> {
    await this.call("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}`);
  }

  /** Charges the saved wallet with the buyer not present. */
  async charge(req: ChargeRequest): Promise<Charge> {
    const value = toValue(req.amountCents);
    const orderJson = await this.call("POST", "/v2/checkout/orders", {
      requestId: req.reference,
      prefer: true,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: req.reference.slice(0, 256),
            description: req.description.slice(0, 127),
            amount: { currency_code: req.currency, value },
          },
        ],
        payment_source: { paypal: { vault_id: req.vaultId } },
      },
    });
    let order = parse(orderSchema, orderJson, "order");

    if (!order.purchase_units?.[0]?.payments?.captures?.length) {
      if (order.status !== "APPROVED") {
        throw new PayPalError(`PayPal left the order ${order.status}, so it was not paid.`, {
          code: order.status,
          uncertain: false,
        });
      }
      const captured = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(order.id)}/capture`, {
        requestId: `${req.reference}-capture`,
        prefer: true,
        body: {},
      });
      order = parse(orderSchema, captured, "capture");
    }

    const done = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!done) throw malformed("PayPal returned no capture");
    if (!PAID.has(done.status)) {
      throw new PayPalError(`PayPal did not take the payment (${done.status}).`, {
        code: done.status,
        uncertain: false,
      });
    }
    // The money moved, so a mismatch is something to look at, not to release.
    if (done.amount && (done.amount.value !== value || done.amount.currency_code !== req.currency)) {
      throw new PayPalError(
        `PayPal captured ${done.amount.value} ${done.amount.currency_code}, not ${value} ${req.currency}.`,
        { code: "AMOUNT_MISMATCH", uncertain: true },
      );
    }
    return { orderId: order.id, captureId: done.id, status: done.status };
  }

  async refund(captureId: string, requestId: string): Promise<{ id: string; status: string }> {
    const json = await this.call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      requestId,
      prefer: true,
      body: {},
    });
    return parse(refundSchema, json, "refund");
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_MARGIN_MS) return this.cached.value;
    this.refreshing ??= this.fetchToken().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new PayPalError("Could not reach PayPal to sign in.", { uncertain: false, cause });
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      throw new PayPalError(`PayPal refused our credentials (${json.error ?? res.status}).`, {
        status: res.status,
        code: json.error,
        uncertain: false,
      });
    }
    this.cached = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 300) * 1000 };
    return json.access_token;
  }

  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: unknown; requestId?: string; prefer?: boolean } = {},
  ): Promise<unknown> {
    // Retrying is only safe when PayPal can recognise the repeat.
    const retryable = method === "GET" || method === "DELETE" || Boolean(opts.requestId);
    let refreshedToken = false;
    let lastFailure: PayPalError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}),
            ...(opts.prefer ? { Prefer: "return=representation" } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        lastFailure = new PayPalError("Lost the connection to PayPal.", { uncertain: true, cause });
        if (!retryable || attempt === MAX_ATTEMPTS) throw lastFailure;
        await this.pause(attempt);
        continue;
      }

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.cached = null;
        attempt--; // a stale token is not a failed attempt
        continue;
      }

      const text = await res.text();
      const json = text ? safeJson(text) : null;

      if (res.ok) return json;

      const err = errorFrom(res.status, json);
      if (res.status >= 500 && retryable && attempt < MAX_ATTEMPTS) {
        lastFailure = err;
        await this.pause(attempt);
        continue;
      }
      throw err;
    }
    throw lastFailure ?? new PayPalError("PayPal did not answer.", { uncertain: true });
  }

  private pause(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
  }
}

/** Whole cents to the decimal string PayPal wants, with no floating point. */
export function toValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RangeError(`bad amount: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorFrom(status: number, json: unknown): PayPalError {
  const body = (json ?? {}) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] };
  const issue = body.details?.[0];
  const parts = [issue?.description ?? body.message ?? `PayPal returned ${status}`];
  if (body.debug_id) parts.push(`(debug id ${body.debug_id})`);
  return new PayPalError(parts.join(" "), {
    status,
    code: issue?.issue ?? body.name,
    debugId: body.debug_id,
    uncertain: status >= 500,
  });
}

function parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  const result = schema.safeParse(json);
  if (!result.success) throw malformed(`PayPal sent back a ${what} we could not read`);
  return result.data;
}

// A reply we cannot read may still mean PayPal acted, so we do not call it a clean failure.
function malformed(message: string): PayPalError {
  return new PayPalError(message, { uncertain: true });
}

function checkedPayPalUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw malformed("PayPal sent an approval link that is not a URL");
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || !(host === "paypal.com" || host.endsWith(".paypal.com"))) {
    throw malformed("PayPal sent an approval link to an unexpected site");
  }
  return url.toString();
}
