export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  consume(key: string, nowMs: number = Date.now()): RateLimitDecision {
    const cutoff = nowMs - this.windowMs;
    const prev = this.buckets.get(key) ?? [];
    const active = prev.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      const oldest = active[0] ?? nowMs;
      const retryMs = Math.max(1000, oldest + this.windowMs - nowMs);
      this.buckets.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryMs / 1000),
      };
    }

    active.push(nowMs);
    this.buckets.set(key, active);

    // Opportunistic cleanup for stale keys
    if (this.buckets.size > 500) {
      for (const [k, list] of this.buckets.entries()) {
        if (list.every((ts) => ts <= cutoff)) {
          this.buckets.delete(k);
        }
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
    };
  }
}
