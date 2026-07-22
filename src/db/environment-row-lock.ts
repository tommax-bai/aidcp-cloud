/**
 * 环境级串行的唯一取锁出口（change publish-approval-signal-to-database §5）。
 *
 * 为什么不是 advisory lock：`interaction-env:<envKey>` 过去是一把**跨未来服务边界**的库级 advisory
 * lock —— 写侧（客户解绑 / 批量改派 / 撤销对账）拆分后属 api，边缘上报的环境登录态首写属 automation。
 * advisory lock 的致命性质是：一旦两侧连到不同库、不同实例，或某一侧被指到只读副本，
 * **两边各自加锁都会成功、互斥消失，而且不产生任何错误**。这正是本项目红线禁止的静默失效形态。
 *
 * 行锁的关键差别：它绑定**被保护数据所在的那张表**。`client_environments` 跟着环境注册表走，
 * 锁与数据永远同库；真到拆库那一天，另一侧连不到这张表是**响亮的失败**，不是无声的互斥消失。
 *
 * 使用约束：
 * - MUST 在调用方已开启的事务内调用（行锁随事务释放）；
 * - 多个环境 MUST 按 `envKey` 升序逐个调用，保持既有取锁顺序（死锁序不回归）；
 * - **环境未注册（注册表无行）时锁不成立**：`SELECT ... FOR UPDATE` 命中 0 行既不加锁也不报错。
 *   这一分支 MUST NOT 被当成「已加锁」放过——换掉 advisory lock 却留一个同样无声的失效点，等于没换。
 *   故本函数把它作为**可判定的返回值** `'unregistered'` 交出去并记一条日志；被保护的写侧
 *   （`InteractionStore.upsertAuthStatus`）据此回落去锁该环境的客户归属行 `client_env_scope`。
 */

export interface EnvironmentRowLockClient {
  query(sql: string, params: unknown[]): Promise<{ rowCount?: number | null }>;
}

/** 取锁结果。`unregistered` = 注册表无此环境行 ⇒ **本次没有加上任何锁**，绝不可当作已加锁。 */
export type EnvironmentRowLockOutcome = 'locked' | 'unregistered';

export async function lockEnvironmentRow(
  client: EnvironmentRowLockClient,
  envKey: string,
  logger: Pick<Console, 'warn'> = console,
): Promise<EnvironmentRowLockOutcome> {
  const res = await client.query('SELECT 1 FROM client_environments WHERE env_key = $1 FOR UPDATE', [envKey]);
  if ((res?.rowCount ?? 0) > 0) return 'locked';
  logger.warn(
    `[env-lock] 环境 ${envKey} 不在注册表 client_environments 中：本次未取得环境行锁`
    + '（MUST NOT 当作已加锁；调用方须自行判定是否仍存在并发对手）',
  );
  return 'unregistered';
}

/**
 * 回落锁：锁住该环境的客户归属行 `client_env_scope`。
 *
 * 用途只有一个——注册表尚无此环境时补上互斥。客户停用 / 解绑侧是**遍历 `client_env_scope`** 找环境的
 * （对注册表只做 LEFT JOIN，注册行缺失照样往下走），故归属行才是那条路径真正的入口；锁住它即可与之串行。
 * 返回被锁行数：0 = 该环境既未注册、也未归属任何客户 ⇒ 解绑侧遍历不到它 ⇒ 确无对手，这是**有依据的**
 * 不加锁，与「没锁到也当锁到了」不是一回事。
 */
export async function lockEnvironmentScopeRows(
  client: EnvironmentRowLockClient,
  envKey: string,
): Promise<number> {
  const res = await client.query('SELECT 1 FROM client_env_scope WHERE env_key = $1 FOR UPDATE', [envKey]);
  return res?.rowCount ?? 0;
}
