export interface RateLimitPolicy {
  maxRequests: number;
  windowMs: number;
}

/** Fixed-window in-memory rate limiter keyed by caller identity. */
export class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();

  constructor(private defaults: RateLimitPolicy) {}

  check(key: string, policy: RateLimitPolicy = this.defaults): boolean {
    const now = Date.now();
    const record = this.counts.get(key);

    if (!record || now > record.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + policy.windowMs });
      return true;
    }

    if (record.count >= policy.maxRequests) {
      return false;
    }

    record.count++;
    return true;
  }

  /**
   * Generic fixed-window consumption (token metering): admits `amount`
   * units against `max` per window. Pass max=Infinity to record without
   * ever denying (post-response reconciliation).
   */
  consume(key: string, max: number, windowMs: number, amount = 1): boolean {
    const now = Date.now();
    const record = this.counts.get(key);
    if (!record || now > record.resetAt) {
      // Deny BEFORE recording: an oversized request must not poison the
      // fresh window and lock out everything that follows it.
      if (amount > max) {
        return false;
      }
      this.counts.set(key, { count: amount, resetAt: now + windowMs });
      return true;
    }
    if (record.count + amount > max) {
      return false;
    }
    record.count += amount;
    return true;
  }

  /** Milliseconds until the window resets, for Retry-After headers. */
  retryAfterMs(key: string): number {
    const record = this.counts.get(key);
    return record ? Math.max(0, record.resetAt - Date.now()) : 0;
  }
}
