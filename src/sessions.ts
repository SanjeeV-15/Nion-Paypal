import { randomBytes } from "node:crypto";
import type { SpendingGate } from "./limits/gate.js";
import type { ConfirmReason } from "./limits/policy.js";

export interface PendingQuestion {
  proposalId: string;
  expiresAt: number;
  merchantId: string;
  amountCents: number;
  reasons: ConfirmReason[];
}

export interface ConnectedWallet {
  vaultId: string;
  customerId?: string;
  email?: string;
}

export interface Session {
  id: string;
  gate: SpendingGate;
  pending: PendingQuestion | null;
  /** The buyer's saved PayPal wallet, once they approved it. */
  paypal: ConnectedWallet | null;
  /** The setup token this visitor is in the middle of approving. */
  paypalSetupId: string | null;
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
