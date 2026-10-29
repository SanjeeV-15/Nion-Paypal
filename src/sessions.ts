import { randomBytes } from "node:crypto";
import type { SpendingGate } from "./limits/gate.js";
import type { Bill } from "./bills.js";
import { sampleBills } from "./bills.js";
import type { ConfirmReason } from "./limits/policy.js";

export interface PendingQuestion {
  proposalId: string;
  expiresAt: number;
  merchantId: string;
  amountCents: number;
  reasons: ConfirmReason[];
  /** Set when the payment is for one of the visitor's bills. */
  billId?: string;
}

export interface ConnectedWallet {
  vaultId: string;
  customerId?: string;
  email?: string;
  /** The shared demo wallet: many visitors use it, so it must never be deleted at PayPal. */
  shared?: boolean;
}

export interface Session {
  id: string;
  gate: SpendingGate;
  pending: PendingQuestion | null;
  /** The buyer's saved PayPal wallet, once they approved it. */
  paypal: ConnectedWallet | null;
  /** The setup token this visitor is in the middle of approving. */
  paypalSetupId: string | null;
  /** The visitor's bills, with sample due dates. */
  bills: Bill[];
  /** Plain-text turns the agent remembers, oldest first. */
  history: { role: "user" | "assistant"; content: string }[];
  lastSeen: number;
}

export interface SessionStoreOptions {
  createGate: () => SpendingGate;
  ttlMs: number;
  max: number;
  now?: () => number;
}

/** One wallet per visitor, so people trying the hosted demo cannot spend each other's limits. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** True if this id belongs to a live session, without touching it. */
  has(id: string | undefined): boolean {
    const session = id ? this.sessions.get(id) : undefined;
    return session !== undefined && this.now() - session.lastSeen <= this.options.ttlMs;
  }

  /** Start the demo over: new payments, bills and limits. The PayPal connection stays. */
  reset(session: Session): void {
    session.gate = this.options.createGate();
    session.bills = sampleBills(this.now());
    session.pending = null;
    session.history = [];
  }

  get(id: string | undefined): { session: Session; created: boolean } {
    const now = this.now();
    this.dropExpired(now);

    const existing = id ? this.sessions.get(id) : undefined;
    if (existing) {
      existing.lastSeen = now;
      // Re-insert so the map stays ordered from least to most recently used.
      this.sessions.delete(existing.id);
      this.sessions.set(existing.id, existing);
      return { session: existing, created: false };
    }

    while (this.sessions.size >= this.options.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      gate: this.options.createGate(),
      pending: null,
      paypal: null,
      paypalSetupId: null,
      bills: sampleBills(now),
      history: [],
      lastSeen: now,
    };
    this.sessions.set(session.id, session);
    return { session, created: true };
  }

  private dropExpired(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.options.ttlMs) this.sessions.delete(id);
      else break; // ordered by last use, so the rest are newer
    }
  }
}

const MAX_HISTORY = 20;

/**
 * Adds one exchange to what the agent remembers. Every way a payment can move, including the
 * buttons, must call this: otherwise the model's memory stops at an open question.
 * Keeps plain text only, so history stays valid however long the chat runs.
 */
export function remember(session: Session, user: string, assistant: string): void {
  session.history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
  if (session.history.length > MAX_HISTORY) {
    session.history.splice(0, session.history.length - MAX_HISTORY);
    while (session.history[0]?.role === "assistant") session.history.shift();
  }
}
