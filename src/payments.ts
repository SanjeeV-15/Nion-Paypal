import type { LedgerEntry, Outcome } from "./limits/gate.js";
import type { Session } from "./sessions.js";

/** Moves the money for a payment the gate has already cleared. */
export interface Executor {
  /** Returns a reference for the completed payment, or throws. */
  pay(entry: LedgerEntry): Promise<string>;
  /** Added to the spoken receipt, e.g. to say nothing really moved. */
  readonly note: string;
}

export const demoExecutor: Executor = {
  async pay(entry) {
    return `demo-${entry.id.slice(0, 8)}`;
  },
  note: " This is a demo, so no money actually moved.",
};

/** Turns what the gate decided into a settled payment, a stored question, or a refusal. */
export async function settle(session: Session, out: Outcome, executor: Executor): Promise<string> {
  const { gate } = session;

  if (out.status === "denied") {
    session.pending = null;
    return out.message;
  }

  if (out.status === "needs_confirmation") {
    session.pending = {
      proposalId: out.proposalId,
      expiresAt: out.expiresAt,
      merchantId: out.request.merchantId,
      amountCents: out.request.amountCents,
      reasons: out.reasons,
    };
    return `${out.message} Say yes to confirm, or no to cancel.`;
  }

  session.pending = null;
  const entry = gate.history().find((e) => e.id === out.reservationId);
  if (!entry) throw new Error(`reservation ${out.reservationId} vanished`);
  try {
    gate.complete(out.reservationId, await executor.pay(entry));
  } catch (err) {
    gate.fail(out.reservationId);
    console.error("payment failed", err);
    return "The payment did not go through, and nothing was charged.";
  }
  return `${out.message}${executor.note}`;
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
): Promise<string> {
  const { pending, gate } = session;
  if (!pending) return "There is nothing waiting for an answer.";

  if (answer === "no") {
    gate.cancel(pending.proposalId);
    session.pending = null;
    return "Okay, I cancelled that. Nothing was paid.";
  }
  return settle(session, gate.confirm(pending.proposalId), executor);
}
