import { formatMoney } from "./limits/policy.js";
import { payeeName } from "./merchants.js";
import { settle, type Executor, type Settled } from "./payments.js";
import type { Session } from "./sessions.js";

export type BillStatus = "due" | "paid" | "unconfirmed";

export interface Bill {
  id: string;
  name: string;
  /** Who it is paid to; always one of the approved payees. */
  payeeId: string;
  amountCents: number;
  /** YYYY-MM-DD, in UTC. */
  dueDate: string;
  status: BillStatus;
}

const DAY = 24 * 60 * 60 * 1000;

// Sample bills, due soon after the visitor arrives so the demo always looks current.
// The rent is deliberately above the per-payment limit: the gate should refuse it.
const SAMPLE: { id: string; name: string; payeeId: string; amountCents: number; inDays: number }[] = [
  { id: "phone", name: "Phone plan", payeeId: "skyline-mobile", amountCents: 4_250, inDays: 3 },
  { id: "credit-card", name: "Credit card", payeeId: "summit-card", amountCents: 6_000, inDays: 6 },
  { id: "electric", name: "Electric", payeeId: "bright-power", amountCents: 3_820, inDays: 9 },
  { id: "rent", name: "Rent", payeeId: "maple-apartments", amountCents: 90_000, inDays: 12 },
];

export const BILL_IDS = SAMPLE.map((b) => b.id);

export function sampleBills(now: number): Bill[] {
  return SAMPLE.map((b) => ({
    id: b.id,
    name: b.name,
    payeeId: b.payeeId,
    amountCents: b.amountCents,
    dueDate: new Date(now + b.inDays * DAY).toISOString().slice(0, 10),
    status: "due",
  }));
}

/** Whole days from today to the due date, in UTC. Negative once it is overdue. */
export function daysUntil(dueDate: string, now: number): number {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return Math.round((Date.parse(dueDate) - today) / DAY);
}

export function findBill(session: Session, billId: string): Bill | undefined {
  return session.bills.find((b) => b.id === billId);
}

/**
 * Pays a bill through the same spending gate as everything else. The amount and
 * the payee come from the bill itself, never from the caller, so nothing the
 * model says can change what a bill costs or who it goes to.
 */
export async function payBill(session: Session, billId: string, executor: Executor): Promise<Settled> {
  const bill = findBill(session, billId);
  if (!bill) return { kind: "unavailable", message: "I don't have a bill like that." };
  if (bill.status === "paid") return { kind: "unavailable", message: `Your ${bill.name.toLowerCase()} bill is already paid.` };
  if (bill.status === "unconfirmed") {
    return {
      kind: "unavailable",
      message:
        `I couldn't confirm the last payment for your ${bill.name.toLowerCase()} bill, so I won't pay it again. ` +
        "Please check PayPal first.",
    };
  }

  const blocked = executor.ready(session);
  if (blocked) return { kind: "not_ready", message: blocked };

  const { gate } = session;
  // A new request replaces any question that is still open.
  if (session.pending) gate.cancel(session.pending.proposalId);
  session.pending = null;

  const out = gate.request({
    merchantId: bill.payeeId,
    amountCents: bill.amountCents,
    currency: gate.limits().currency,
  });
  return settle(session, out, executor, bill.id);
}

/** A bill as the model and the page see it. */
export function describeBill(bill: Bill, now: number, currency: string) {
  const days = daysUntil(bill.dueDate, now);
  return {
    id: bill.id,
    name: bill.name,
    pay_to: payeeName(bill.payeeId),
    amount_usd: bill.amountCents / 100,
    amount_text: formatMoney(bill.amountCents, currency),
    due_date: bill.dueDate,
    due_in_days: days,
    status: bill.status === "due" && days < 0 ? "overdue" : bill.status,
  };
}
