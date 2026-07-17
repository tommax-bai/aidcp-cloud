/**
 * 动作冷却闸（**兜底层**）—— change engagement-restraint，语义于 change cooldown-as-backstop-not-quota 改判。
 *
 * 按账号、按动作类型维护一道**最小间隔冷却**：同一账号的同一类互动（like/collect/follow/comment）
 * 两次真实发生之间至少间隔 COOLDOWN_MS[action]。
 *
 * ## 定位：兜底，不是数量闸
 *
 * 系统里有两套东西在管「一个账号能做多少互动」，职责必须分清：
 *  - **主闸 = 风控配额**（quota_config 表 / RiskController.canDo）：**单独负责数量**。面板可配、热加载、
 *    三档联动风控状态、PG 持久化。天花板 100% 由它决定。
 *  - **兜底 = 本闸**：只防**意外**爆发——同秒重入、同账号并行会话（N:1）同刻双发、重启后首发。
 *    这是主闸干不了的活：配额只数数量、不管间距；单场预算每会话各一份。本闸是全局单例按账号分桶，
 *    是**唯一**给出「最小间距」的机制。平时它应当完全隐形，只在异常里说话。
 *
 * ## 🔴 不变量（本文件存在的理由，MUST 保持）
 *
 *   **兜底必须比主闸松。** 对每个动作、每个可达档位、每个窗口 W（分/时/日）：
 *   COOLDOWN_MS[action] ≤ 窗口长度 L_W ÷ 该窗口配额 q_W。
 *
 * 等价的运营口径：**主闸的每一个旋钮都必须真的能拧动**。冷却若在窗口 W 上比主闸紧，那个旋钮就被焊死了
 * ——运营调大配额会「行为纹丝不动、无日志、无告警」，主闸沦为摆设。改判前四个动作全部违反此不变量
 * （comment 的 30min 冷却最大速率恰＝小时配额 2/h，把该旋钮焊死）。
 *
 * 该不变量 typecheck 抓不到，只由 test/risk/action-cooldown.test.ts 的回归断言守住——**别删那条测试**。
 * 取值路径侧的对偶保证见 config/quota-config-store.ts（perMinute 夹 MINUTE_BURST_CAP）。
 *
 * ## 15s 的推导（不是拍的）
 *
 *   15s = 60s ÷ max(四动作的分钟爆发上限) = 60 ÷ MINUTE_BURST_CAP.like(=4)
 *
 * 15 是「不焊死任何旋钮」的**最大统一值**：各动作上界为 like 15s / collect 20s / follow 60s / comment 60s，
 * 四者都能取 15。like 在 aggressive 档压线（1.00×）而**压线合格**：本闸取等放行（now - last >= interval），
 * 配额是半开窗 (t-L, t] 且 count >= quota 才拒 ⇒ 以 c = L/q 等间隔跑，窗内恒为 q-1 < q ⇒ 该窗口配额可
 * 无限跑满 ⇒ c = L/q 不削主闸。给 follow/comment 单配更大的值在行为上完全等价（一场只准 1 次），
 * 差异化只增认知负担；给 comment 单配「因为评论更敏感」＝把策略重新编码进硬编码常量，正是本次要根除的。
 *
 * ## 其余红线（原样保留）
 *  - **附加只读兜底闸**，不是风控状态：MUST NOT 写 risk_state / 调 setQuotaLevel·applySignal / 改 quotaLevel。
 *    账号风控终态仍仅由 RiskController 单写（本闸只读判定 + 记内存时间戳）。
 *  - 判定全在云端（边缘不做任何策略）。冷却记录为**进程内内存态**：无需持久化、无迁移、不经协议；
 *    云端重启后清零（主闸是 PG 持久化 + 启动回灌 ⇒ 重启后数量约束完好；首发的间距由静默期补，见 options）。
 *  - 时间由调用方注入（nowMs），便于单测注入假时钟。
 *  - 按账号隔离（不同账号互不影响）；按账号单例 / 全局单例共享均可（内部已按 accountId 分桶）。
 *  - **拦截即丢弃、不排队不补发**（调用方语义）。这是可接受代价，**当且仅当**上述不变量成立（冷却可证明
 *    不削主闸的任一窗口配额 ⇒ 损失趋零）。谁把冷却调回大值，谁就同时把「永久吃掉互动意图」装回来。
 *
 * 起算时机（由调用方保证）：MUST 在**互动真实成功**（边缘回执 ok:true）时 markActed，而非下发时——
 * 与「计数挂真回执」同口径，避免一次失败动作白占一个冷却窗；follow 的 already_followed 良性 no-op 不算一次真关注、不 markActed。
 */

/** 受冷却约束的动作类型（四个真实互动；comment_like / search 等不在本闸范围）。 */
export type CooldownAction = 'like' | 'collect' | 'follow' | 'comment';

/**
 * 各动作的最小间隔（毫秒）。**四动作统一 15s** —— 兜底值，不是数量闸（见文件头）。
 *
 * 15_000 = 60_000 ÷ MINUTE_BURST_CAP.like(=4)，即「不焊死任何旋钮」的最大统一值。
 * 🔴 改动此处 MUST 同时满足文件头不变量（c ≤ L_W / q_W，逐动作逐窗口），
 *    回归断言在 test/risk/action-cooldown.test.ts。
 */
export const COOLDOWN_MS: Readonly<Record<CooldownAction, number>> = {
  like: 15_000,
  collect: 15_000,
  follow: 15_000,
  comment: 15_000,
};

/**
 * 受冷却约束的动作全集——**取自 `COOLDOWN_MS` 的键**，故新增冷却动作会自动纳入下列两处、不会漏：
 *  1. 不变量回归断言（test/risk/action-cooldown.test.ts）；
 *  2. 主闸取值路径的 `perMinute` 夹 cap（config/quota-config-store.ts）。
 *
 * 🔴 夹 cap **MUST 只作用于本集合**。风控动作全集（`RISK_ACTIONS`）里还有不受冷却约束的动作，
 *    对它们夹 `MINUTE_BURST_CAP` 既无立论（不变量只谈冷却动作），又会造成真实伤害：
 *    `MINUTE_BURST_CAP.dm_reply = 0`（＝「旧浏览曲线没有 dm_reply 语义」的占位，不是真爆发上限）
 *    ⇒ 夹了它就把运营在面板上显式配置的额度**永久压成 0**、`canDo` 恒拒（配额 0 即硬拒），
 *    而 `risk-controller.ts` 的慢启动 clamp 早已专门为此开了 dm_reply 豁免
 *    （「不能把运营明确配置的非零额度再次夹成 0」）——在取值口夹会**从上游架空那条豁免**。
 *    那正是本 change 要根除的病（旋钮被焊死、无日志无告警），只是换了个动作。
 */
export const COOLDOWN_ACTIONS: readonly CooldownAction[] = Object.keys(COOLDOWN_MS) as CooldownAction[];

export interface ActionCooldownGateOptions {
  /**
   * 进程启动时刻（ms，change account-nurture-discipline-spine §4.1）：重启冷启动静默期的起算点。
   * 缺省 → 构造时刻。
   */
  startedAtMs?: number;
  /**
   * 重启冷启动静默期时长（ms）。0 = 关闭。
   *
   * 冷却记录为进程内内存态、重启即清零 ⇒ **兜底对「每账号每动作的第一发」是瞎的**（无历史 → 放行）。
   * 静默窗内暂抑制该账号本进程尚无成功记录的互动，恰好把这一发的最小间距补上；窗口过即恢复正常冷却语义。
   * 只压 4 类互动，不拦浏览、不写风控终态。
   *
   * 🔴 它**同受文件头不变量约束**（它就是首发那一刻的冷却）。原立论「重启清零 ⇒ 数量 burst」已被
   * change cooldown-as-backstop-not-quota 抽空：主闸是 PG 持久化 + 启动回灌，重启后数量约束完好、
   * 分钟窗地板照旧 ⇒ 静默期只该管**间距**、不该管数量。默认值随冷却同为 15s（见 server.ts 装配处）；
   * 留旧的 180s ＝ 病灶从冷却搬到静默期（严 12×，且严于 follow/comment 的 60s 主闸地板）。
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
