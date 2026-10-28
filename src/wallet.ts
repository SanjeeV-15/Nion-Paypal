import type { EntryStatus } from "./limits/gate.js";
import type { ConfirmReason } from "./limits/policy.js";
import { MERCHANTS } from "./merchants.js";
import type { Session } from "./sessions.js";

export interface WalletSnapshot {
  mode: "demo" | "sandbox";
  limits: ReturnType<Session["gate"]["limits"]>;
  spentCents: number;
  remainingCents: number;
  merchants: { id: string; name: string; blurb: string }[];
  activity: {
    id: string;
    merchant: string;
    amountCents: number;
    status: EntryStatus;
    at: number;
    ref?: string;
  }[];
  /** Null in demo mode, where there is no PayPal to connect. */
  paypal: { connected: boolean; email?: string } | null;
  pending: {
    proposalId: string;
    expiresAt: number;
    merchant: string;
    amountCents: number;
    reasons: ConfirmReason[];
  } | null;
}

export function walletSnapshot(session: Session, mode: WalletSnapshot["mode"]): WalletSnapshot {
  const { gate } = session;
  const names = new Map(MERCHANTS.map((m) => [m.id, m.name]));
  if (session.pending && Date.now() >= session.pending.expiresAt) session.pending = null;

  return {
    mode,
    limits: gate.limits(),
    spentCents: gate.spentToday(),
    remainingCents: gate.remainingToday(),
    merchants: MERCHANTS.map((m) => ({ ...m })),
    activity: gate
      .history()
      .map((e) => ({
        id: e.id,
        merchant: names.get(e.request.merchantId) ?? e.request.merchantId,
        amountCents: e.request.amountCents,
        status: e.status,
        at: e.at,
        ...(e.ref ? { ref: e.ref } : {}),
      }))
      .reverse(),
    paypal:
      mode === "sandbox"
        ? {
            connected: session.paypal !== null,
            ...(session.paypal?.email ? { email: session.paypal.email } : {}),
          }
        : null,
    pending: session.pending
      ? {
          proposalId: session.pending.proposalId,
          expiresAt: session.pending.expiresAt,
          merchant: names.get(session.pending.merchantId) ?? session.pending.merchantId,
          amountCents: session.pending.amountCents,
          reasons: session.pending.reasons,
        }
      : null,
  };
}
