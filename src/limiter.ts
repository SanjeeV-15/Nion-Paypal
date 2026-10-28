export type Take = { ok: true } | { ok: false; reason: "visitor" | "day" };

export interface LimiterOptions {
  perVisitorPerHour: number;
  perDay: number;
  now?: () => number;
}

const HOUR = 60 * 60 * 1000;

/**
 * Caps how often the AI model is called, because each call costs real money
 * and a hosted demo is open to anyone. One visitor cannot use more than a fair
 * share, and the whole site has a daily ceiling.
 */
export class ChatLimiter {
  private readonly now: () => number;
  private readonly visitors = new Map<string, number[]>();
  private day = "";
  private dayCount = 0;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  take(visitorId: string): Take {
    const now = this.now();
    this.prune(now);

    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.options.perDay) return { ok: false, reason: "day" };

    const recent = this.visitors.get(visitorId) ?? [];
    if (recent.length >= this.options.perVisitorPerHour) return { ok: false, reason: "visitor" };

    recent.push(now);
    this.visitors.set(visitorId, recent);
    this.dayCount++;
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [id, times] of this.visitors) {
      const fresh = times.filter((t) => now - t < HOUR);
      if (fresh.length === 0) this.visitors.delete(id);
      else if (fresh.length !== times.length) this.visitors.set(id, fresh);
    }
  }
}
