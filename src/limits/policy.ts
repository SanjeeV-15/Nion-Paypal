export interface Policy {
  currency: string;
  timeZone: string;
  /** Payments at or below this go through without asking. */
  autoApproveUpToCents: number;
  /** Hard ceiling for one payment, even with the user's yes. */
  perPurchaseCapCents: number;
  /** Hard ceiling for everything spent or reserved in one local day. */
  dailyCapCents: number;
  approvedMerchants: readonly string[];
  /** Same merchant and amount inside this window needs a yes. */
  duplicateWindowMs: number;
  /** How long a question to the user stays answerable. */
  confirmationTtlMs: number;
}

export interface PaymentRequest {
  merchantId: string;
  amountCents: number;
  currency: string;
}

export type DenyReason =
  | "invalid_amount"
  | "currency_mismatch"
  | "merchant_not_approved"
  | "over_purchase_cap"
  | "over_daily_cap"
  | "proposal_not_found"
  | "proposal_expired";

export type ConfirmReason = "above_auto_approve" | "possible_duplicate";

export interface ResolvedPolicy extends Policy {
  currency: string;
  approvedSet: ReadonlySet<string>;
}

const isCents = (n: number) => Number.isSafeInteger(n) && n > 0;

export function resolvePolicy(policy: Policy): ResolvedPolicy {
  const currency = policy.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`currency must be a 3-letter code, got "${policy.currency}"`);
  }
  // Throws RangeError on an unknown zone.
  new Intl.DateTimeFormat("en-CA", { timeZone: policy.timeZone });

  for (const key of ["autoApproveUpToCents", "perPurchaseCapCents", "dailyCapCents"] as const) {
    if (!isCents(policy[key])) throw new Error(`${key} must be a positive whole number of cents`);
  }
  if (policy.autoApproveUpToCents > policy.perPurchaseCapCents) {
    throw new Error("autoApproveUpToCents cannot exceed perPurchaseCapCents");
  }
  if (policy.perPurchaseCapCents > policy.dailyCapCents) {
    throw new Error("perPurchaseCapCents cannot exceed dailyCapCents");
  }
  for (const key of ["duplicateWindowMs", "confirmationTtlMs"] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) {
      throw new Error(`${key} must be zero or more milliseconds`);
    }
  }

  const merchants = policy.approvedMerchants.map((m) => m.trim()).filter(Boolean);
  return { ...policy, currency, approvedMerchants: merchants, approvedSet: new Set(merchants) };
}

export function normalizeRequest(req: PaymentRequest): PaymentRequest {
  return {
    merchantId: req.merchantId.trim(),
    amountCents: req.amountCents,
    currency: req.currency.trim().toUpperCase(),
  };
}

// Assumes a two-decimal currency, which covers the USD sandbox demo.
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function dayKeyFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms: number) => fmt.format(ms);
}
