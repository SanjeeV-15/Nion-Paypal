import type { LedgerEntry, Outcome } from "./limits/gate.js";
import { formatMoney } from "./limits/policy.js";
import type { Session } from "./sessions.js";

/** Thrown when we cannot tell whether the money moved. */
export class PaymentUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaymentUncertainError";
  }
}

/** Moves the money for a payment the gate has already cleared. */
export interface Executor {
  /** Returns a reference for the completed payment. Throws if it failed, or PaymentUncertainError if unsure. */
  pay(session: Session, entry: LedgerEntry): Promise<string>;
  /** A reason payments cannot start yet, or null when they can. */
  ready(session: Session): string | null;
  /** What to say once a payment went through; summary reads like "$12.00 to Sunrise Cafe". */
  receipt(summary: string): string;
}

export const demoExecutor: Executor = {
  async pay(_session, entry) {
    return `demo-${entry.id.slice(0, 8)}`;
  },
  ready: () => null,
  receipt: (summary) => `Cleared to pay ${summary}. This is a demo, so no money actually moved.`,
};

export type SettledKind = "paid" | "asked" | "denied" | "failed" | "unconfirmed" | "cancelled" | "idle";

/** What happened, in words to speak and in a form the agent can reason about. */
export interface Settled {
  kind: SettledKind;
  message: string;
}

/** Turns what the gate decided into a settled payment, a stored question, or a refusal. */
export async function settle(session: Session, out: Outcome, executor: Executor): Promise<Settled> {
  const { gate } = session;

  if (out.status === "denied") {
    session.pending = null;
    return { kind: "denied", message: out.message };
  }

  if (out.status === "needs_confirmation") {
    session.pending = {
      proposalId: out.proposalId,
      expiresAt: out.expiresAt,
      merchantId: out.request.merchantId,
      amountCents: out.request.amountCents,
      reasons: out.reasons,
    };
    return { kind: "asked", message: `${out.message} Say yes to confirm, or no to cancel.` };
  }

  session.pending = null;
  const entry = gate.history().find((e) => e.id === out.reservationId);
  if (!entry) throw new Error(`reservation ${out.reservationId} vanished`);
  const summary = `${formatMoney(entry.request.amountCents, entry.request.currency)} to ${gate.merchantLabel(entry.request.merchantId)}`;

  let ref: string;
  try {
    ref = await executor.pay(session, entry);
  } catch (err) {
    if (err instanceof PaymentUncertainError) {
      // Never hand the money back when we do not know where it went.
      gate.flagUnconfirmed(out.reservationId);
      console.error("payment unconfirmed:", err.message);
      return {
        kind: "unconfirmed",
        message:
          `I couldn't confirm whether the ${summary} payment went through. ` +
          "I'm keeping it counted against your daily limit until you check PayPal.",
      };
    }
    gate.fail(out.reservationId);
    console.error("payment failed:", err instanceof Error ? err.message : err);
    return { kind: "failed", message: "The payment did not go through, and nothing was charged." };
  }
  gate.complete(out.reservationId, ref);
  return { kind: "paid", message: executor.receipt(summary) };
}

/**
 * The user said yes or no to the open question. This is the only way a
 * question gets answered, whether by voice or by the on-screen buttons, and
 * the model never takes part in it.
 */
export async function answerPending(
  session: Session,
  answer: "yes" | "no",
  executor: Executor,
): Promise<Settled> {
  const { pending, gate } = session;
  if (!pending) return { kind: "idle", message: "There is nothing waiting for an answer." };

  if (answer === "no") {
    gate.cancel(pending.proposalId);
    session.pending = null;
    return { kind: "cancelled", message: "Okay, I cancelled that. Nothing was paid." };
  }
  return settle(session, gate.confirm(pending.proposalId), executor);
}
