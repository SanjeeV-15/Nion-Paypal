import { randomUUID } from "node:crypto";
import {
  dayKeyFormatter,
  formatMoney,
  normalizeRequest,
  resolvePolicy,
  type ConfirmReason,
  type DenyReason,
  type PaymentRequest,
  type Policy,
  type ResolvedPolicy,
} from "./policy.js";

export type Decision =
  | { outcome: "approve" }
  | { outcome: "confirm"; reasons: ConfirmReason[]; message: string }
  | { outcome: "deny"; reason: DenyReason; message: string };

export type Outcome =
  | { status: "approved"; reservationId: string; message: string }
  | {
      status: "needs_confirmation";
      proposalId: string;
      expiresAt: number;
      reasons: ConfirmReason[];
      request: PaymentRequest;
      message: string;
    }
  | { status: "denied"; reason: DenyReason; message: string };

export type EntryStatus = "pending" | "unconfirmed" | "completed" | "failed";

export interface LedgerEntry {
  id: string;
  request: PaymentRequest;
  at: number;
  status: EntryStatus;
  ref?: string;
}

interface Proposal {
  request: PaymentRequest;
  expiresAt: number;
}

export interface GateOptions {
  now?: () => number;
  newId?: () => string;
  /** Spoken name for a merchant id; defaults to the id itself. */
  merchantName?: (merchantId: string) => string;
}

/**
 * Every payment the agent wants to make goes through here. The model can ask,
 * but only this class can hand out a reservation, and it never takes the
 * model's word for anything beyond the payment itself.
 */
export class SpendingGate {
  private readonly policy: ResolvedPolicy;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly dayKey: (ms: number) => string;
  private readonly merchantName: (merchantId: string) => string;
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly proposals = new Map<string, Proposal>();

  constructor(policy: Policy, options: GateOptions = {}) {
    this.policy = resolvePolicy(policy);
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.dayKey = dayKeyFormatter(this.policy.timeZone);
    this.merchantName = options.merchantName ?? ((id) => id);
  }

  evaluate(input: PaymentRequest): Decision {
    const req = normalizeRequest(input);
    const p = this.policy;
    const money = (cents: number) => formatMoney(cents, p.currency);

    if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) {
      return deny("invalid_amount", "The amount has to be a positive amount of money.");
    }
    if (req.currency !== p.currency) {
      return deny("currency_mismatch", `Only ${p.currency} payments are allowed.`);
    }
    if (!p.approvedSet.has(req.merchantId)) {
      return deny("merchant_not_approved", `${req.merchantId} is not on your approved list.`);
    }
    if (req.amountCents > p.perPurchaseCapCents) {
      return deny(
        "over_purchase_cap",
        `${money(req.amountCents)} is over your ${money(p.perPurchaseCapCents)} limit for one payment.`,
      );
    }
    const spent = this.spentToday();
    if (spent + req.amountCents > p.dailyCapCents) {
      return deny(
        "over_daily_cap",
        `That would take you past your ${money(p.dailyCapCents)} daily limit. ` +
          `${money(Math.max(p.dailyCapCents - spent, 0))} is left today.`,
      );
    }

    const reasons: ConfirmReason[] = [];
    const parts: string[] = [];
    if (req.amountCents > p.autoApproveUpToCents) {
      reasons.push("above_auto_approve");
      parts.push(`it is over your ${money(p.autoApproveUpToCents)} auto-approve limit`);
    }
    if (this.isDuplicate(req)) {
      reasons.push("possible_duplicate");
      parts.push("you paid the same amount to the same place a moment ago");
    }
    if (reasons.length > 0) {
      return {
        outcome: "confirm",
        reasons,
        message: `Pay ${money(req.amountCents)} to ${this.merchantName(req.merchantId)}? I'm asking because ${parts.join(" and ")}.`,
      };
    }
    return { outcome: "approve" };
  }

  /** Ask to pay. Approved requests are reserved immediately. */
  request(input: PaymentRequest): Outcome {
    const req = normalizeRequest(input);
    const decision = this.evaluate(req);
    if (decision.outcome === "deny") {
      return { status: "denied", reason: decision.reason, message: decision.message };
    }
    if (decision.outcome === "approve") {
      return this.reserve(req);
    }
    this.dropExpiredProposals();
    const proposalId = this.newId();
    const expiresAt = this.now() + this.policy.confirmationTtlMs;
    this.proposals.set(proposalId, { request: req, expiresAt });
    return {
      status: "needs_confirmation",
      proposalId,
      expiresAt,
      reasons: decision.reasons,
      request: req,
      message: decision.message,
    };
  }

  /**
   * The user said yes to one specific proposal. Only the payment stored with
   * the proposal can go through, and the hard limits are checked again.
   */
  confirm(proposalId: string): Outcome {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return {
        status: "denied",
        reason: "proposal_not_found",
        message: "There is nothing waiting for a yes.",
      };
    }
    this.proposals.delete(proposalId);
    if (this.now() >= proposal.expiresAt) {
      return {
        status: "denied",
        reason: "proposal_expired",
        message: "That question timed out, so I did not pay. Ask me again if you still want it.",
      };
    }
    const decision = this.evaluate(proposal.request);
    if (decision.outcome === "deny") {
      return { status: "denied", reason: decision.reason, message: decision.message };
    }
    return this.reserve(proposal.request);
  }

  cancel(proposalId: string): boolean {
    return this.proposals.delete(proposalId);
  }

  /** The PayPal capture succeeded. */
  complete(reservationId: string, ref: string): void {
    this.settle(reservationId, "completed").ref = ref;
  }

  /**
   * We could not tell whether the money moved. It stays counted against the
   * daily limit until someone checks, so a doubtful payment never frees budget.
   */
  flagUnconfirmed(reservationId: string): void {
    const entry = this.entries.get(reservationId);
    if (!entry) throw new Error(`unknown reservation ${reservationId}`);
    if (entry.status !== "pending") {
      throw new Error(`reservation ${reservationId} is already ${entry.status}`);
    }
    entry.status = "unconfirmed";
  }

  merchantLabel(merchantId: string): string {
    return this.merchantName(merchantId);
  }

  /** The payment did not happen; give the money back to the daily budget. */
  fail(reservationId: string): void {
    this.settle(reservationId, "failed");
  }

  limits() {
    const { currency, autoApproveUpToCents, perPurchaseCapCents, dailyCapCents } = this.policy;
    return { currency, autoApproveUpToCents, perPurchaseCapCents, dailyCapCents };
  }

  spentToday(): number {
    const today = this.dayKey(this.now());
    let total = 0;
    for (const e of this.entries.values()) {
      if (e.status !== "failed" && this.dayKey(e.at) === today) total += e.request.amountCents;
    }
    return total;
  }

  remainingToday(): number {
    return Math.max(this.policy.dailyCapCents - this.spentToday(), 0);
  }

  history(): LedgerEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, request: { ...e.request } }));
  }

  private reserve(req: PaymentRequest): Outcome {
    const id = this.newId();
    this.entries.set(id, { id, request: req, at: this.now(), status: "pending" });
    return {
      status: "approved",
      reservationId: id,
      message: `Cleared to pay ${formatMoney(req.amountCents, this.policy.currency)} to ${this.merchantName(req.merchantId)}.`,
    };
  }

  private settle(reservationId: string, status: "completed" | "failed"): LedgerEntry {
    const entry = this.entries.get(reservationId);
    if (!entry) throw new Error(`unknown reservation ${reservationId}`);
    if (entry.status !== "pending" && entry.status !== "unconfirmed") {
      throw new Error(`reservation ${reservationId} is already ${entry.status}`);
    }
    entry.status = status;
    return entry;
  }

  private isDuplicate(req: PaymentRequest): boolean {
    const since = this.now() - this.policy.duplicateWindowMs;
    for (const e of this.entries.values()) {
      if (
        e.status !== "failed" &&
        e.at >= since &&
        e.request.merchantId === req.merchantId &&
        e.request.amountCents === req.amountCents
      ) {
        return true;
      }
    }
    return false;
  }

  private dropExpiredProposals(): void {
    const now = this.now();
    for (const [id, p] of this.proposals) {
      if (now >= p.expiresAt) this.proposals.delete(id);
    }
  }
}

function deny(reason: DenyReason, message: string): Decision {
  return { outcome: "deny", reason, message };
}
