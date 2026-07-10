/**
 * 动作冷却闸（节奏层）—— change engagement-restraint。
 *
 * 按账号、按动作类型维护一道**最小间隔冷却**：同一账号的同一类互动（like/collect/follow/comment）
 * 两次真实发生之间至少间隔 COOLDOWN_MS[action]。把自动互动的节奏压稀、更拟人、延缓每日配额触顶。
 *
 * 定位与红线：
 *  - **附加只读节奏闸**，不是风控状态：MUST NOT 写 risk_state / 调 setQuotaLevel·applySignal / 改 quotaLevel。
 *    账号风控终态仍仅由 RiskController 单写（本闸只读判定 + 记内存时间戳）。
 *  - 判定全在云端（边缘不做任何策略）。冷却记录为**进程内内存态**：无需持久化、无迁移、不经协议；
 *    云端重启后清零（短暂放宽可接受，真实发生计时 + 配额层仍兜底）。
 *  - 时间由调用方注入（nowMs），便于单测注入假时钟。
 *  - 按账号隔离（不同账号互不影响）；按账号单例 / 全局单例共享均可（内部已按 accountId 分桶）。
 *
 * 起算时机（由调用方保证）：MUST 在**互动真实成功**（边缘回执 ok:true）时 markActed，而非下发时——
 * 与「计数挂真回执」同口径，避免一次失败动作白占一个冷却窗；follow 的 already_followed 良性 no-op 不算一次真关注、不 markActed。
 */

/** 受冷却约束的动作类型（四个真实互动；comment_like / search 等不在本闸范围）。 */
export type CooldownAction = 'like' | 'collect' | 'follow' | 'comment';

/** 各动作的最小间隔（毫秒）。like 2min / collect 5min / follow 10min / comment 30min。 */
export const COOLDOWN_MS: Readonly<Record<CooldownAction, number>> = {
  like: 2 * 60_000,
  collect: 5 * 60_000,
  follow: 10 * 60_000,
  comment: 30 * 60_000,
};

export interface ActionCooldownGateOptions {
  /**
   * 进程启动时刻（ms，change account-nurture-discipline-spine §4.1）：重启冷启动静默期的起算点。
   * 缺省 → 构造时刻。
   */
  startedAtMs?: number;
  /**
   * 重启冷启动静默期时长（ms）。0 = 关闭（历史行为，零回归）。
   * 冷却记录为进程内内存态、重启即清零——若不设静默期，重启瞬间每类互动都「无历史 → 放行」，
   * 一个账号可立刻把四类互动各打一发（burst），绕过本该有的最小间隔拟人节奏。静默窗内暂抑制该账号
   * 本进程尚无成功记录的互动，窗口过即恢复正常冷却语义。只压 4 类互动，不拦浏览、不写风控终态。
   */
  restartQuietMs?: number;
}

export class ActionCooldownGate {
  /** account → (action → 上次真实成功的时间戳 ms)。 */
  private readonly lastByAccount = new Map<string, Map<CooldownAction, number>>();
  private readonly startedAtMs: number;
  private readonly restartQuietMs: number;

  constructor(options: ActionCooldownGateOptions = {}) {
    this.startedAtMs = options.startedAtMs ?? Date.now();
    this.restartQuietMs = options.restartQuietMs ?? 0;
  }

  /**
   * 该账号该动作是否已过冷却（可以下发）。
   * 无配置间隔的动作 → 放行；无历史记录（从未成功过）→ 放行。
   * 重启冷启动静默期内（restartQuietMs>0 且尚在窗口）：该账号该动作本进程尚无成功记录 → 暂抑制（防重启 burst）。
   */
  canAct(accountId: string, action: CooldownAction, nowMs: number): boolean {
    const intervalMs = COOLDOWN_MS[action];
    if (intervalMs === undefined) return true; // 未配置冷却的动作不拦
    const lastTs = this.lastByAccount.get(accountId)?.get(action);
    if (lastTs === undefined) {
      if (this.restartQuietMs > 0 && nowMs < this.startedAtMs + this.restartQuietMs) return false; // 静默期防 burst
      return true; // 从未成功过 → 放行
    }
    return nowMs - lastTs >= intervalMs;
  }

  /** 距下次可动作的剩余毫秒（已可动作时为 0）；仅供可观测 / 日志，不参与判定语义。 */
  remainingMs(accountId: string, action: CooldownAction, nowMs: number): number {
    const intervalMs = COOLDOWN_MS[action];
    if (intervalMs === undefined) return 0;
    const lastTs = this.lastByAccount.get(accountId)?.get(action);
    if (lastTs === undefined) return 0;
    return Math.max(0, intervalMs - (nowMs - lastTs));
  }

  /** 记一次「真实成功」的动作时间戳（仅在 ok:true、follow 非 already_followed 时调用）。 */
  markActed(accountId: string, action: CooldownAction, nowMs: number): void {
    let m = this.lastByAccount.get(accountId);
    if (!m) {
      m = new Map();
      this.lastByAccount.set(accountId, m);
    }
    m.set(action, nowMs);
  }
}
