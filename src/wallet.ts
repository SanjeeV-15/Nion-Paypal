import type { EntryStatus } from "./limits/gate.js";
import type { ConfirmReason } from "./limits/policy.js";
import { daysUntil, type BillStatus } from "./bills.js";
import { MERCHANTS, payeeName } from "./merchants.js";
import type { Session } from "./sessions.js";

export interface WalletSnapshot {
  mode: "demo" | "sandbox";
  limits: ReturnType<Session["gate"]["limits"]>;
  spentCents: number;
  remainingCents: number;
  merchants: { id: string; name: string; blurb: string }[];
  bills: {
    id: string;
    name: string;
    payee: string;
    amountCents: number;
    dueDate: string;
    daysUntilDue: number;
    status: BillStatus;
  }[];
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
    /** Name of the bill this payment is for, if it is one. */
    billName?: string;
  } | null;
}

export function walletSnapshot(session: Session, mode: WalletSnapshot["mode"]): WalletSnapshot {
  const { gate } = session;
  if (session.pending && Date.now() >= session.pending.expiresAt) session.pending = null;

  return {
    mode,
    limits: gate.limits(),
    spentCents: gate.spentToday(),
    remainingCents: gate.remainingToday(),
    merchants: MERCHANTS.map((m) => ({ ...m })),
    bills: session.bills.map((b) => ({
      id: b.id,
      name: b.name,
      payee: payeeName(b.payeeId),
      amountCents: b.amountCents,
      dueDate: b.dueDate,
      daysUntilDue: daysUntil(b.dueDate, Date.now()),
      status: b.status,
    })),
    activity: gate
      .history()
      .map((e) => ({
        id: e.id,
        merchant: payeeName(e.request.merchantId),
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
          merchant: payeeName(session.pending.merchantId),
          amountCents: session.pending.amountCents,
          reasons: session.pending.reasons,
          ...(session.pending.billId
            ? { billName: session.bills.find((b) => b.id === session.pending?.billId)?.name }
            : {}),
        }
      : null,
  };
}
