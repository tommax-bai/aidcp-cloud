/**
 * 离场清理授权（cleanup grant）的**跨域操作**纯类型端口（kernel 段，Block③ 物理拆库 L3）。
 *
 * 背景：签发与烧掉这张授权票的两个操作，历史上写在 api 属主的 `client-auth/client-user-store.ts` 里，
 * 由它 `BEGIN` 出一条 **api 池**的连接、再把那个事务句柄传给 automation 的写适配器。
 * 但这两笔事务**碰的表全是 automation 属主**（`interaction_offboards` / `interaction_offboard_audit`），
 * 一张 api 表都没有 —— 它们是「由 api 的代码发起的、纯 automation 的事务」。
 * 拆库后那条 api 连接跑不了 automation 的 SQL（表不在那个库），故整个操作 MUST 收回属主域：
 * **由 automation 侧自己开事务、自己在 automation 池上执行**，api 侧只经本端口转调。
 *
 * 历史对照：同域的离场写曾经走一个**接调用方事务句柄**的端口（`client-auth/offboard-write-port.ts`），
 * 因为那些写确实与 api 侧的归属收权共提交，是真跨域事务。change block3-l3-offboard-eventual-consistency
 * 把它整体改成了最终一致（准入落 api 自己的库 + 属主自开事务物化台账），那个端口随之删除，
 * 替代者是 kernel 的 `offboard-materialization-types.ts`。**三个端口现在一致：不接句柄、各自成一笔事务**
 * —— 这正是「拆库后仍成立」的判据。
 *
 * ## 搬迁时 MUST 逐字保留的不变量（每一条都有能踩的红线）
 *
 * 1. **五档失败判定的顺序即优先级**：`not_found` → `scope_mismatch` → `already_used` → `expired`
 *    → `not_pending`，首个命中即定。顺序变了，同一次请求的对外状态码就会变。
 * 2. **失败路径 `COMMIT`、不是 `ROLLBACK`**：被拒绝的授权尝试要留下审计行。回滚会把审计一起丢掉。
 *    唯一例外：连行都不存在（`not_found`）时不写审计。
 * 3. **取行的 `FOR UPDATE` 与随后的「烧票 + 写审计」MUST 同一笔事务、同一条连接**。
 *    烧票那条 `UPDATE` **不查影响行数**，它今天正确的唯一理由就是同事务里已用 `FOR UPDATE` 证明该行存在且持锁。
 *    拆成两次调用 / 两笔事务 = 0 行也返回成功 = **静默假成功**（客户拿到清理引导，而票从未被烧掉）。
 * 4. **`now` 是可注入的判定时钟**（过期判定用它，不是实现内部各自取当前时间），供测试与重放。
 * 5. 时间戳一律 epoch ms（`Date` 不过 HTTP）。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名 /
 * 无模块级活状态 / 无 setTimeout。
 */

/** 离场记录状态 / 原因的取值域（与 automation 属主表一致；跨域契约的一部分）。 */
export type OffboardGrantState = 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
export type OffboardGrantReason = 'environment_unbind' | 'customer_terminated' | 'admin_revoked';

/** 被授权的那条离场记录的投影。时间戳 epoch ms。 */
export interface OffboardGrantRecord {
  offboardId: string;
  envKey: string;
  accountId: string;
  state: OffboardGrantState;
  reason: OffboardGrantReason;
  requestedAt: number;
  purgeDueAt: number;
}

export interface IssueOffboardCleanupGrantInput {
  offboardId: string;
  /** 归属客户；归属事实存在离场行自身（`user_id`），故作为写入谓词、绝不放宽。 */
  userId: string;
  edgeId: string;
  /** 只落**票据身份的哈希**；明文 bearer token 绝不进数据库、也绝不进审计行。 */
  jtiHash: string;
  expiresAt: number;
}

export type ConsumeOffboardCleanupGrantFailure =
  | 'not_found'
  | 'scope_mismatch'
  | 'expired'
  | 'already_used'
  | 'not_pending';

export interface ConsumeOffboardCleanupGrantInput {
  userId: string;
  offboardId: string;
  envKey: string;
  accountId: string;
  edgeId: string;
  jtiHash: string;
  /** 过期判定时钟（epoch ms）。MUST 由调用方给定，实现不得自取当前时间。 */
  now: number;
}

export type ConsumeOffboardCleanupGrantOutcome =
  | { ok: true; offboard: OffboardGrantRecord }
  | { ok: false; reason: ConsumeOffboardCleanupGrantFailure };

/**
 * 离场清理授权的属主侧操作。两个方法**各自成一笔事务**（不接调用方句柄），跑在 automation 池上。
 * 拆进程后同一端口换 HTTP 客户端，api 侧调用点零改动。
 */
export interface OffboardCleanupGrantOperations {
  /**
   * 条件签发：命中「归属该客户 且 仍处 pending_edge / dispatched」的离场行才写票并记审计。
   * 状态不符 / 不归属 / 行不存在 → 返回 false（不写审计，与改动前逐字同）。
   */
  issueCleanupGrant(input: IssueOffboardCleanupGrantInput): Promise<boolean>;
  /**
   * 原子核验并烧票：取行加锁 → 逐项比对 → 命中则烧票 + 记 consumed 审计；
   * 不命中则记 rejected 审计（行不存在时不记）。**两种结局都提交**（见文件头不变量 2）。
   */
  consumeCleanupGrant(input: ConsumeOffboardCleanupGrantInput): Promise<ConsumeOffboardCleanupGrantOutcome>;
}
