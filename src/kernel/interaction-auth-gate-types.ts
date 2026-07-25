/**
 * 互动域「环境授权闸」的跨域纯类型端口（Block③ 物理拆库 L3）。
 *
 * ## 它解决的是哪个**反方向**跨属主互斥
 *
 * 拆库清单此前只列了 api → automation 一个方向，漏了反方向：边缘上报的**环境登录态首写**
 * （`InteractionStore.upsertAuthStatus`，automation 事务）历史上直接去锁 **api 属主**的
 * `client_environments`（命中 0 行时回落锁 `client_env_scope`），并在同一笔 automation 事务里对
 * api 属主的 `client_env_revocation_holds` / `accounts` 取 `FOR SHARE`。
 * 互斥对手写在 `src/db/environment-row-lock.ts` 文件头：写侧（客户解绑 / 批量改派 / 撤销对账）拆分后
 * 属 **api**，登录态首写属 **automation** —— 两个对手**按定义在两个域**，所以「属主本地行锁 + 幂等键」
 * 这条公式在这里落空。
 *
 * 而跨库行锁的失效是**无声的**：两侧连不同库时两边各自加锁都会成功、互斥消失、且不报任何错。
 * 这正是本仓红线禁止的形态（同一教训已在 environment-row-lock.ts 头注释里付过一次代价）。
 *
 * ## 形态：闸在 api、写在 automation ⇒ **两笔** + 条件写回执
 *
 * 属主判定（`boundaries/table-ownership.json`）：
 *   - 闸要读的四张表 `client_environments` / `client_env_scope` / `client_env_revocation_holds` /
 *     `accounts` 全属 **api**；
 *   - 被写的 `interaction_auth_state` / `interaction_runtime_controls` 属 **automation**。
 * 两者不同属主 ⇒ 不可能塞进同一笔本地事务。故闸收敛成 api 侧的窄内部端点：
 *   ① api 在**自己的库、自己的事务**里取环境级行锁 + 判归属是否被撤销 + 校验账号主数据，
 *      判定通过即发一张**带有效期的条件写回执**（`InteractionAuthWriteReceipt`）并提交；
 *   ② automation 拿着回执才在自己的事务里落登录态；**回执缺失 / 被拒 / 已过期 ⇒ MUST 拒绝写入**
 *      （fail-closed，绝不「问不到就当放行」——那等于给一个正被撤权的环境重开互动写）。
 *
 * **RPC 本身不持锁**：这是「要么条件写、要么分布式锁」的分叉点，本项目的答案一贯是前者
 * （不引入 Redis / 锁服务，决策见控制仓 docs/redis-decision-cross-db-locks-and-async-bus.md）。
 *
 * ## 回执**能**保证什么、**不能**保证什么（MUST NOT 过度宣称）
 *
 * 能：
 *   - 环境级行锁回到 api 的单库单表，与 api 侧解绑 / 停用 / 改派共用同一把锁 —— 拆库后仍然互斥，
 *     而不是无声地失去互斥；
 *   - 判定与回执在**同一笔 api 事务**里给出，故不存在「读到旧快照又按旧快照发票」的裂缝；
 *   - automation 侧是**结构上**一次性的：回执是方法内的局部值，签发后立即在同一次调用里用掉，
 *     不落库、不出方法作用域、不可能被第二次写入复用。
 * 不能：
 *   - 覆盖「回执签发提交 → automation 写入提交」这段窗口内才发生的撤销。跨库场景下**任何**不引入
 *     分布式锁的方案都覆盖不了它；本端口把它压到 `ttlMs` 以内并如实登记。
 *     这段窗口的兜底不在本端口，而在 automation 自己那笔事务里仍然存在的离场检查
 *     （`interaction_offboards` 中该环境有未清理离场 ⇒ 本次登录态上报只留审计、不落状态），
 *     以及离场清理每一轮都会重算的绑定核验。
 */

/** 闸的拒绝理由。**顺序即优先级**，与改动前 `assertAccountScope` 的判定顺序逐字一致。 */
export type InteractionAuthGateDenial =
  /** 该环境的客户归属正处撤销 hold（改动前：`client_env_revocation_holds` 命中）。 */
  | 'environment_revoked'
  /** 账号主数据不存在（改动前：`accounts` 查不到 ⇒ 404）。 */
  | 'account_not_found'
  /** 账号平台与互动请求不匹配（改动前：`accounts.platform` 不等 ⇒ 409）。 */
  | 'account_platform_mismatch';

/**
 * 本次判定实际取到了哪一级环境级串行。
 *   - `registered`：锁住了注册表 `client_environments` 的行；
 *   - `customer_scoped`：注册表无行，改锁该环境的客户归属行 `client_env_scope`；
 *   - `unclaimed`：两者皆无行 ⇒ 解绑侧遍历不到这个环境 ⇒ 确无并发对手。
 *     这是**有依据的不加锁**，与「没锁到也当锁到了」不是一回事，故必须作为可判定的值交出去。
 */
export type InteractionEnvironmentSerialization = 'registered' | 'customer_scoped' | 'unclaimed';

export interface InteractionAuthWriteAuthorizationInput {
  platform: string;
  accountId: string;
  envKey: string;
  /** 判定 / 签发时钟（epoch ms）。MUST 由调用方给定，实现不得自取当前时间（便于测试与重放）。 */
  now: number;
  /** 回执有效期（ms）。automation 侧落地前 MUST 重新校验未过期。 */
  ttlMs: number;
}

/** 条件写回执。时间戳一律 epoch ms（`Date` 不过 HTTP）。 */
export interface InteractionAuthWriteReceipt {
  platform: string;
  accountId: string;
  envKey: string;
  issuedAt: number;
  /** 过期即作废：automation MUST 在落地前比对，过期 ⇒ 拒绝写入（fail-closed）。 */
  expiresAt: number;
  environmentSerialization: InteractionEnvironmentSerialization;
}

export type InteractionAuthWriteAuthorization =
  | { ok: true; receipt: InteractionAuthWriteReceipt }
  | { ok: false; reason: InteractionAuthGateDenial };

export interface InteractionScopeCheckInput {
  platform: string;
  accountId: string;
  envKey: string;
}

/** 非首写路径（同步批次入库）的一次性归属判定：只要结论，不需要回执。 */
export type InteractionScopeCheck =
  | { ok: true }
  | { ok: false; reason: InteractionAuthGateDenial };

/**
 * 互动域环境授权闸的 **api 属主侧**操作。两个方法**各自成一笔事务**（不接调用方句柄），跑在 api 池上。
 * 拆进程后同一端口换 HTTP 客户端，automation 侧调用点零改动。
 *
 * ## MUST 逐字保留的不变量
 * 1. **调用点在 automation 事务之外**。它是一次 RPC，不是锁：若在 automation 已开启的事务里调用，
 *    就形成「api 连接等 automation 持有的行 / automation 连接等 api 持有的行」这种**跨连接**等待环 ——
 *    PostgreSQL 的死锁检测器看不见它（两条连接在它眼里毫无关系），结果是两边一起挂到超时。
 * 2. **拒绝理由的顺序即优先级**：`environment_revoked` → `account_not_found` →
 *    `account_platform_mismatch`，首个命中即定。顺序变了，同一次请求的对外状态码就变。
 * 3. **`authorizeAuthStateWrite` 不查撤销 hold**：登录态首写路径历史上就是带 `allowRevocationHold`
 *    调用的（撤销进行中仍允许边缘把登录态报上来，靠离场检查决定要不要落）。这条 MUST NOT 顺手「修正」。
 * 4. **调不通 = 拒绝**。端口未注入 / 实现抛错，调用方 MUST 让错误上抛，MUST NOT 兜成放行。
 */
export interface InteractionAuthGate {
  /** 登录态首写闸：环境级串行 + 账号主数据校验 ⇒ 条件写回执。**不查**撤销 hold（见不变量 3）。 */
  authorizeAuthStateWrite(
    input: InteractionAuthWriteAuthorizationInput,
  ): Promise<InteractionAuthWriteAuthorization>;
  /** 同步批次入库闸：撤销 hold + 账号主数据校验，一次判定、无回执、不取环境级行锁。 */
  checkAccountScope(input: InteractionScopeCheckInput): Promise<InteractionScopeCheck>;
}
