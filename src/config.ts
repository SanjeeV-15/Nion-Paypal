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

/**
 * The address PayPal sends the buyer back to. An explicit setting wins; on Render
 * the service's own URL is provided automatically; locally it is localhost.
 * Empty values count as unset, because Render sets some variables to "".
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  return env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
}
