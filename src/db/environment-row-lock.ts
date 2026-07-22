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
 * - 环境未注册（无行）时不加锁：此时也没有对手——所有客户侧路径都只对已注册环境生效
 *   （它们都 JOIN 了 `client_environments`）。
 */

export interface EnvironmentRowLockClient {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

/** advisory lock key 前缀 → 允许引用它的服务边界目录（advisory-lock 归属静态检查的白名单）。 */
export const SINGLE_SERVICE_ADVISORY_LOCK_KEYS: ReadonlyArray<{ keyPrefix: string; ownerDir: string; why: string }> = [
  {
    keyPrefix: 'interaction-send|',
    ownerDir: 'src/interactions',
    why: '同账号发送串行；只被 InteractionStore 引用，随其整体归属一个服务，不跨边界。',
  },
  {
    keyPrefix: '<platform>|<accountId>|<batchId>',
    ownerDir: 'src/interactions',
    why: '收件箱批次幂等；只被 InteractionStore 引用，不跨边界。',
  },
];

export async function lockEnvironmentRow(client: EnvironmentRowLockClient, envKey: string): Promise<void> {
  await client.query('SELECT 1 FROM client_environments WHERE env_key = $1 FOR UPDATE', [envKey]);
}
