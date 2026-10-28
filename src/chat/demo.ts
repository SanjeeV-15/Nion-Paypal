import { daysUntil, payBill } from "../bills.js";
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
    if (answer !== "other") return (await answerPending(session, answer, executor)).message;
  }

  const bill = billNamed(session, message);
  if (bill && /\bpay\b/i.test(message)) return (await payBill(session, bill, executor)).message;

  if (/\b(bills?|due|owe)\b/i.test(message)) {
    return session.bills
      .map((b) => {
        const days = daysUntil(b.dueDate, Date.now());
        const when = days < 0 ? "overdue" : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;
        return `${b.name}, ${money(b.amountCents)}, ${b.status === "paid" ? "paid" : when}.`;
      })
      .join(" ");
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
    return (await settle(session, out, executor)).message;
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

const BILL_WORDS: Record<string, RegExp> = {
  phone: /\bphone\b/i,
  "credit-card": /\bcredit card\b/i,
  electric: /\b(electric|electricity|power)\b/i,
  rent: /\brent\b/i,
};

function billNamed(session: Session, text: string): string | undefined {
  return session.bills.find((b) => BILL_WORDS[b.id]?.test(text))?.id;
}
