import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { formatMoney } from "../limits/policy.js";
import { MERCHANTS } from "../merchants.js";
import { settle, type Executor } from "../payments.js";
import type { Session } from "../sessions.js";

type Tool = Anthropic.Beta.BetaTool;

const noInput = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * What the model may do. There is deliberately no tool to confirm a payment:
 * only the user's own yes, or the Confirm button, can do that.
 */
export const TOOLS: Tool[] = [
  {
    name: "list_merchants",
    description: "List the merchants the user has approved. Only these can be paid.",
    input_schema: noInput,
  },
  {
    name: "get_wallet",
    description:
      "Get the user's limits, how much they have spent today and have left, whether payments are ready, " +
      "any payment waiting for their yes, and their recent payments.",
    input_schema: noInput,
  },
  {
    name: "pay",
    description:
      "Pay an approved merchant from the user's PayPal. Small payments go through at once; bigger ones " +
      "are held until the user says yes themselves. Check the status in the result and report it truthfully.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        merchant_id: {
          type: "string",
          enum: MERCHANTS.map((m) => m.id),
          description: "The id of one of the approved merchants.",
        },
        amount_usd: {
          type: "number",
          description: "The amount in US dollars with at most two decimal places, for example 12.5.",
        },
      },
      required: ["merchant_id", "amount_usd"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_pending_payment",
    description: "Cancel the payment that is waiting for the user's yes, when they say they no longer want it.",
    input_schema: noInput,
  },
];

export interface ToolContext {
  session: Session;
  executor: Executor;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Words that can be spoken as they are. Payment outcomes are already clear and
   * exact, so when a turn is just one payment step the model is not asked to
   * rephrase them: that saves a full round trip and cannot misreport the result.
   */
  reply?: string;
}

const payInput = z.object({ merchant_id: z.string(), amount_usd: z.number() });

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case "list_merchants":
      return ok(MERCHANTS.map((m) => ({ id: m.id, name: m.name, description: m.blurb })));
    case "get_wallet":
      return ok(walletFacts(ctx));
    case "cancel_pending_payment": {
      const result = cancelPending(ctx.session);
      return ok(result, "message" in result ? result.message : undefined);
    }
    case "pay":
      return pay(input, ctx);
    default:
      return fail(`There is no tool called "${name}".`);
  }
}

async function pay(input: unknown, { session, executor }: ToolContext): Promise<ToolResult> {
  const parsed = payInput.safeParse(input);
  if (!parsed.success) return fail("pay needs a merchant_id and an amount_usd that is a number.");

  const cents = usdToCents(parsed.data.amount_usd);
  if (cents === null) return fail("The amount must be a positive number of dollars with at most two decimal places.");

  const blocked = executor.ready(session);
  if (blocked) return ok({ status: "not_ready", message: blocked }, blocked);

  const { gate } = session;
  // A new request replaces any question that is still open.
  if (session.pending) gate.cancel(session.pending.proposalId);
  session.pending = null;

  const out = gate.request({
    merchantId: parsed.data.merchant_id,
    amountCents: cents,
    currency: gate.limits().currency,
  });
  const settled = await settle(session, out, executor);

  return ok(
    {
      status: settled.kind,
      message: settled.message,
      ...(settled.kind === "asked"
        ? {
            note:
              "A confirmation card is now on screen. Only the user can confirm it, by saying yes or tapping " +
              "Confirm. Ask them briefly and wait. Do not call pay again for this payment.",
          }
        : {}),
    },
    settled.message,
  );
}

function walletFacts({ session, executor }: ToolContext) {
  const { gate } = session;
  const limits = gate.limits();
  const dollars = (cents: number) => cents / 100;
  const notReady = executor.ready(session);
  const pending = session.pending;

  return {
    currency: limits.currency,
    payments_ready: notReady === null,
    ...(notReady ? { not_ready_reason: notReady } : {}),
    limits: {
      asks_for_a_yes_above_usd: dollars(limits.autoApproveUpToCents),
      max_per_payment_usd: dollars(limits.perPurchaseCapCents),
      max_per_day_usd: dollars(limits.dailyCapCents),
    },
    spent_today_usd: dollars(gate.spentToday()),
    remaining_today_usd: dollars(gate.remainingToday()),
    waiting_for_the_users_yes: pending
      ? { merchant: gate.merchantLabel(pending.merchantId), amount_usd: dollars(pending.amountCents) }
      : null,
    recent_payments: gate
      .history()
      .slice(-5)
      .reverse()
      .map((e) => ({
        merchant: gate.merchantLabel(e.request.merchantId),
        amount_usd: dollars(e.request.amountCents),
        status: e.status,
      })),
  };
}

function cancelPending(session: Session) {
  if (!session.pending) return { status: "nothing_pending" };
  session.gate.cancel(session.pending.proposalId);
  session.pending = null;
  return { status: "cancelled", message: "The waiting payment was cancelled. Nothing was paid." };
}

/** Dollars as a number to whole cents, or null if it is not a clean positive amount. */
export function usdToCents(amount: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) return null;
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** How a waiting payment reads in the model's context. */
export function describePending(session: Session): string | null {
  const { pending, gate } = session;
  if (!pending) return null;
  const money = formatMoney(pending.amountCents, gate.limits().currency);
  return `${money} to ${gate.merchantLabel(pending.merchantId)}`;
}

function ok(value: unknown, reply?: string): ToolResult {
  return { content: JSON.stringify(value), ...(reply ? { reply } : {}) };
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}
