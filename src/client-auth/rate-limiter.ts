/**
 * 登录限流器（内存滑窗，按 key = name / IP 双维计数）。change edge-client-customer-auth。
 *
 * 防暴力猜 key + 防用户名枚举（配合 key.ts 的 decoyVerify）。内存实现、重启清零——
 * 与 revocation.ts 内存取向一致（内部/客户工具、重启少）；留 PG 缝。
 */

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

export interface RateLimiterOptions {
  /** 窗口内允许的失败尝试数（超过则拦截）。 */
  max: number;
  /** 窗口时长（ms）。 */
  windowMs: number;
}

export class LoginRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions = { max: 8, windowMs: 5 * 60_000 }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
  }

  /** 是否已被限流（任一维度 name/ip 撞顶即拦）。返回需等待的秒数（0 = 放行）。 */
  retryAfter(keys: string[], nowMs: number = Date.now()): number {
    let wait = 0;
    for (const k of keys) {
      const b = this.buckets.get(k);
      if (b && nowMs < b.resetAt && b.count >= this.max) {
        wait = Math.max(wait, Math.ceil((b.resetAt - nowMs) / 1000));
      }
    }
    return wait;
  }

  /** 记一次失败尝试（登录失败时调用；成功不计，避免正常使用被误伤）。 */
  recordFailure(keys: string[], nowMs: number = Date.now()): void {
    for (const k of keys) {
      const b = this.buckets.get(k);
      if (!b || nowMs >= b.resetAt) {
        this.buckets.set(k, { count: 1, resetAt: nowMs + this.windowMs });
      } else {
        b.count += 1;
      }
    }
  }

  /** 登录成功后清掉该 name/ip 的计数（避免累计误伤）。 */
  clear(keys: string[]): void {
    for (const k of keys) this.buckets.delete(k);
  }

  /** 清理过期桶（可挂定时；恒小，惰性即可）。 */
  sweep(nowMs: number = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (nowMs >= b.resetAt) this.buckets.delete(k);
    }
  }
}
