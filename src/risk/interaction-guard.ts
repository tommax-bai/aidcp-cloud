/**
 * 同账号并行（N:1）互动去重闸（multi-account-node-support D7②）。
 *
 * 同一账号被多个 edge 节点并行驱动时，两节点各刷各的 feed，多数时候看到的笔记不同；但一旦撞同一篇 / 同一作者，
 * 点赞 / 收藏 / 关注 / 评论 / 评论赞会真重复。点赞/收藏虽有 risk_interactions 落库去重（事后、且仅 like/collect），
 * 但**关注 / 评论 / 评论赞无 per-note 落库去重**，且两节点近乎同时下发时落库去重也来不及——故必须在**下发前按账号**拦：
 *
 *  - in-flight 声明：下发即占坑（带 TTL 自动释放，防回执丢失永久占坑）；
 *  - 已完成集合：成功回执记入，避免本进程内对同一目标重复动作；
 *  - 失败 / no-op：仅释放在途坑、不记已完成（允许后续重试）。
 *
 * 去重单位**按账号**（经 InteractionGuardRegistry 按 accountId 单例 → 同账号 N 连接共用一个 guard，
 * 共享 in-flight / completed 状态），与「同账号共用单一风控控制器（额度合并不翻倍）」对齐。
 */

/** 受去重保护的互动动作。 */
export type GuardAction = 'like' | 'collect' | 'follow' | 'comment' | 'comment_like';

const GUARDED_ACTIONS = new Set<string>(['like', 'collect', 'follow', 'comment', 'comment_like']);

/** 某动作是否受 N:1 去重保护。 */
export function isGuardedInteraction(action: string): action is GuardAction {
  return GUARDED_ACTIONS.has(action);
}

export interface InteractionGuardOptions {
  /** 在途坑自动释放时长（毫秒，防回执丢失永久占坑）。默认 120000。 */
  claimTtlMs?: number;
  /** 注入定时器（测试用）：返回一个 clear 句柄。默认 setTimeout（unref）。 */
  setTimerImpl?: (cb: () => void, ms: number) => { clear: () => void };
}

/** 单账号互动去重状态（in-flight + 已完成）。 */
export class InteractionGuard {
  private readonly inFlight = new Map<string, { clear: () => void }>();
  private readonly completed = new Set<string>();
  private readonly claimTtlMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => { clear: () => void };

  constructor(options: InteractionGuardOptions = {}) {
    this.claimTtlMs = options.claimTtlMs ?? 120_000;
    this.setTimer =
      options.setTimerImpl ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        (t as { unref?: () => void }).unref?.();
        return { clear: () => clearTimeout(t) };
      });
  }

  /**
   * 互动目标键：
   *  - like/collect/comment → 按笔记（noteId）；
   *  - follow → 按作者（authorId，无 per-note 语义）；
   *  - comment_like → 按笔记+评论锚（无 per-note 语义，锚到具体评论）。
   * 缺目标（解析不出键）→ 返回 null（调用方据此放行，不去重，绝不静默吞）。
   */
  static keyFor(action: GuardAction, params: Record<string, unknown> | undefined): string | null {
    const noteId = typeof params?.noteId === 'string' ? params.noteId : undefined;
    const authorId = typeof params?.authorId === 'string' ? params.authorId : undefined;
    const commentAnchorId = typeof params?.commentAnchorId === 'string' ? params.commentAnchorId : undefined;
    switch (action) {
      case 'follow':
        return authorId ? `follow::${authorId}` : null;
      case 'comment_like':
        return noteId ? `comment_like::${noteId}::${commentAnchorId ?? ''}` : null;
      case 'like':
      case 'collect':
      case 'comment':
        return noteId ? `${action}::${noteId}` : null;
      default:
        return null;
    }
  }

  /**
   * 占坑：已在途 / 已完成 → false（调用方跳过下发）；否则占坑（带 TTL 自动释放）→ true。
   * key=null（缺目标）→ true（放行、不去重）。
   */
  tryClaim(key: string | null): boolean {
    if (!key) return true;
    if (this.inFlight.has(key) || this.completed.has(key)) return false;
    const timer = this.setTimer(() => {
      this.inFlight.delete(key);
    }, this.claimTtlMs);
    this.inFlight.set(key, timer);
    return true;
  }

  /** 成功完成：清在途坑 + 记已完成（本进程内不再对同一目标重复动作）。 */
  complete(key: string | null): void {
    if (!key) return;
    this.inFlight.get(key)?.clear();
    this.inFlight.delete(key);
    this.completed.add(key);
  }

  /** 失败 / no-op：仅释放在途坑（不记已完成，允许后续重试）。 */
  releaseFailed(key: string | null): void {
    if (!key) return;
    this.inFlight.get(key)?.clear();
    this.inFlight.delete(key);
  }

  /** 观测：当前在途 / 已完成计数。 */
  stats(): { inFlight: number; completed: number } {
    return { inFlight: this.inFlight.size, completed: this.completed.size };
  }
}

/** 按账号单例的互动去重 guard 注册表（同账号 N 连接共用一个 → 共享 in-flight / completed）。 */
export class InteractionGuardRegistry {
  private readonly byAccount = new Map<string, InteractionGuard>();

  constructor(private readonly options: InteractionGuardOptions = {}) {}

  forAccount(accountId: string): InteractionGuard {
    let guard = this.byAccount.get(accountId);
    if (!guard) {
      guard = new InteractionGuard(this.options);
      this.byAccount.set(accountId, guard);
    }
    return guard;
  }
}
