/**
 * 令牌撤销黑名单（change console-cloud-panel-hardening #26）。
 *
 * 无状态签名 JWT 无法「收回」已签出的令牌——一经签发在 exp 前始终有效，即使泄露也止不住。
 * 本模块维护一个 jti 黑名单，`verifyJwt` 验签通过后额外查它，使「退出登录 / 管理撤销」对服务端可见。
 *
 * 内存实现：jti -> exp(秒)，按 exp 惰性 + 定期清理（令牌自然过期后无需再记，故表恒小）。
 * 跨重启：内存版重启清空——被撤销但尚未到 exp 的令牌会「复活」。配合短 TTL + 滑动续签，泄露窗口有界。
 * 留缝：若需跨重启强撤销，可换 PG 持久化（YAGNI：内部工具、重启少、TTL 短）。
 */

export class TokenRevocationStore {
  private readonly revoked = new Map<string, number>();

  /** 拉黑一个 jti 至其 exp（秒）；空 jti 忽略（旧令牌无 jti 不可撤销）。 */
  revoke(jti: string | undefined, expSeconds: number): void {
    if (jti) this.revoked.set(jti, expSeconds);
  }

  /** 该 jti 是否已被撤销（顺便惰性清理已过 exp 的条目）。空 jti / 未记录 → false。 */
  isRevoked(jti: string | undefined, nowMs: number = Date.now()): boolean {
    if (!jti) return false;
    const exp = this.revoked.get(jti);
    if (exp === undefined) return false;
    if (Math.floor(nowMs / 1000) >= exp) {
      this.revoked.delete(jti); // 已自然过期：无需再记
      return false;
    }
    return true;
  }

  /** 批量清理已过 exp 的死条目（可挂日频定时，防长期未查条目堆积）。 */
  sweep(nowMs: number = Date.now()): number {
    const now = Math.floor(nowMs / 1000);
    let removed = 0;
    for (const [jti, exp] of this.revoked) {
      if (now >= exp) {
        this.revoked.delete(jti);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.revoked.size;
  }
}
