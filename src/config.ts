import { MERCHANTS } from "./merchants.js";
import type { Policy } from "./limits/policy.js";

export function defaultPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  return {
    currency: "USD",
    timeZone: env.NION_TIME_ZONE ?? "UTC",
    autoApproveUpToCents: 2_500,
    perPurchaseCapCents: 10_000,
    dailyCapCents: 15_000,
    approvedMerchants: MERCHANTS.map((m) => m.id),
    duplicateWindowMs: 60_000,
    confirmationTtlMs: 120_000,
  };
}
