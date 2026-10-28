import { classifyAnswer } from "../confirm.js";
import { formatMoney } from "../limits/policy.js";
import { MERCHANTS, findMerchant } from "../merchants.js";
import { answerPending, settle, type Executor } from "../payments.js";
import type { Session } from "../sessions.js";

/**
 * Stand-in for the Claude agent. It understands a handful of fixed phrases so
 * the voice and screen flow can be tried end to end. No money moves.
 */
export async function demoChat(
  session: Session,
  message: string,
  executor: Executor,
): Promise<string> {
  const { gate } = session;
  const currency = gate.limits().currency;
  const money = (cents: number) => formatMoney(cents, currency);

  if (session.pending) {
    const answer = classifyAnswer(message);
    if (answer !== "other") return answerPending(session, answer, executor);
  }

  const pay = /\bpay\b.*?\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks)?\b/i.exec(message);
  if (pay) {
    const merchant = findMerchant(message);
    if (!merchant) {
      const names = MERCHANTS.map((m) => m.name).join(", ");
      return `Who should I pay? I can pay ${names}.`;
    }
    const blocked = executor.ready(session);
    if (blocked) return blocked;
    if (session.pending) gate.cancel(session.pending.proposalId);
    session.pending = null;
    const out = gate.request({
      merchantId: merchant.id,
      amountCents: toCents(pay[1] ?? ""),
      currency,
    });
    return settle(session, out, executor);
  }

  if (/\b(left|remaining|spent|budget|limit)\b/i.test(message)) {
    return `You have spent ${money(gate.spentToday())} today and have ${money(gate.remainingToday())} left.`;
  }

  return (
    "I'm in demo mode, so I only understand simple payments. " +
    `Try "pay $12 to Sunrise Cafe" or "how much do I have left".`
  );
}

function toCents(amount: string): number {
  const [dollars = "0", cents = ""] = amount.split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}
