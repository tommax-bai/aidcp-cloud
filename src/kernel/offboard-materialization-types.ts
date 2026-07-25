/**
 * 离场台账**物化操作**的跨域端口（kernel 段，Block③ 物理拆库 L3 · 离场链最终一致改造）。
 *
 * ## 这个端口替换掉了什么
 *
 * 历史形态：api 属主的 `client-auth/client-user-store.ts` 在自己的 `BEGIN/COMMIT` 里，
 * 把 **api 池**的事务句柄递给 automation 的离场写适配器，于是「撤销归属（api 表）」与
 * 「写离场台账 + 收权 + 审计（automation 表）」是**同一笔跨属主事务**。
 * 物理拆库后那条 api 连接跑不了 automation 的 SQL：表不在那个库 ⇒ `42P01`（客户解绑 / 停用客户 /
 * 改派归属直接 500），或者更坏——两个库各拷了一份表，写进 api 那份、automation 侧派发器永远看不到，
 * 边缘永远收不到清理命令 = **静默假成功**。
 *
 * 现形态：**准入与执行分家**。
 *   - **准入事实**（这个环境是不是正在清理 / 已被撤权）落在 api 自己的库里
 *     （`client_env_revocation_holds`，见 client-user-store 文件头），api 的事务只写自家表，
 *     互斥退化成**本域一张表上的条件写**；
 *   - **执行台账**（离场进行到哪一步、边缘清干净没有）留在 automation
 *     （`interaction_offboards` / `interaction_offboard_audit` / `interaction_auth_state` /
 *     `interaction_runtime_controls`），由本端口在**属主自己的事务**里落。
 *
 * 与同族两个端口的分工：
 *   - `client-env-automation-types.ts`（`ClientEnvAutomationReader`）—— 只读投影；
 *   - `offboard-cleanup-grant-types.ts`（`OffboardCleanupGrantOperations`）—— 清理授权的签发 / 烧票；
 *   - **本端口** —— 离场台账的物化。三者都**不接调用方事务句柄、各自成一笔事务**，
 *     这正是「拆库后仍成立」的判据；单进程期由 automation 池上的本地实现满足，拆进程后换 HTTP 客户端。
 *
 * ## MUST 逐字保留的不变量
 *
 * 1. **幂等键是 `offboardId` + 属主侧 `(platform, env_key) WHERE state <> 'purged'` 唯一索引**。
 *    投递是 at-least-once：同一条准入可能被投多次（进程崩在「属主已提交、api 尚未记回执」之间）。
 *    重投 MUST 落到同一条台账行、MUST NOT 制造第二条离场，也 MUST NOT 报错。
 * 2. **绑定由属主在自己的事务里解析，MUST NOT 由调用方传 accountId 进来**。调用方（api）拿不到
 *    automation 的行锁，它读到的绑定天然是快照；让它传 accountId 等于把一个可能过期的账号写进台账。
 * 3. **解析不到绑定时 MUST NOT 编造**：返回 `{ materialized: false, reason: 'binding_missing' }`，
 *    调用方据此保留「已受理、尚未物化」的准入行、等绑定出现后重试。**绝不返回成功**。
 * 4. **`unboundTerminalAllowed` 只由 api 侧的本域事实决定**（该环境是不是客户自助建号且从未拿到过
 *    互动绑定）。属主 MUST NOT 自行放宽：允许 = 写终态 tombstone；不允许 = 走 3 的等待路径。
 * 5. 时间戳一律 epoch ms（`Date` 不过 HTTP）。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名 /
 * 无模块级活状态 / 无 setTimeout。
 */

import type { OffboardProjection } from './client-env-automation-types.js';

/** 离场原因（与 automation 属主表取值域一致；跨域契约的一部分）。 */
export type OffboardMaterializationReason = 'environment_unbind' | 'customer_terminated' | 'admin_revoked';

export interface MaterializeEnvironmentOffboardInput {
  /** api 侧预生成的离场标识，同时是**幂等键**（见文件头不变量 1）。 */
  offboardId: string;
  envKey: string;
  /** 撤销归属的那个客户；写进台账供归属过滤（清理授权按它下推）。 */
  userId: string;
  reason: OffboardMaterializationReason;
  /** 审计里的发起方（`client:<userId>` / 管理员账号 / null）。 */
  actor: string | null;
  /**
   * 无互动绑定时是否允许直接写终态 tombstone。
   * **只反映 api 侧的本域事实**（客户自助建号且从未绑过账号）；属主 MUST NOT 自行放宽（不变量 4）。
   */
  unboundTerminalAllowed: boolean;
}

/**
 * 物化结果。
 * - `materialized: true` —— 台账行已在属主事务里落定（新建或幂等命中既有行），投影原样交回；
 * - `materialized: false` —— **尚无互动授权绑定**且不允许写终态：属主已在可行范围内收权
 *   （该环境恰好一个运行控制身份时停掉它的读写），但**没有**离场台账行。调用方 MUST 保留准入行、
 *   等绑定出现后重试，MUST NOT 当成成功。
 */
export type MaterializeEnvironmentOffboardOutcome =
  | { materialized: true; offboard: OffboardProjection }
  | { materialized: false; reason: 'binding_missing' };

/**
 * 离场台账的属主侧操作。方法**不接调用方事务句柄、自成一笔事务**，跑在 automation 池上。
 * 拆进程后同一端口换 HTTP 客户端，api 侧调用点零改动。
 */
export interface OffboardMaterializationOperations {
  /**
   * 按一条 api 侧准入把离场台账物化（幂等）：属主自己解析该环境的互动绑定 →
   * 有绑定则写台账 + 收权 + 审计；无绑定则按 `unboundTerminalAllowed` 决定写终态 tombstone
   * 还是只收权并回报 `binding_missing`。
   */
  materializeEnvironmentOffboard(
    input: MaterializeEnvironmentOffboardInput,
  ): Promise<MaterializeEnvironmentOffboardOutcome>;
}
