/**
 * 团队 → 飞书群路由的**纯载荷类型**（kernel 段）。
 *
 * 面板（api）只需要「一条路由长什么样」「写路由的回执长什么样」这两个形状，
 * 不需要也不应该认识 automation 属主的 group_route 存储、连接池与建表语句。
 * 存储实现（GroupRouteStore）留 src/cache/group-route-store.ts（automation），
 * 并从本文件等值再导出，属主侧既有消费方一个字节不改。
 *
 * kernel 门禁（§4.7）：零 import、纯类型；无库访问 / 无 HTTP 路由 / 无模型调用 / 无进程内活状态。
 * 时间戳一律 epoch ms（HTTP 化友好，Date 不过网）。
 */

/** 一条团队路由（读时产物）。updatedAt 为 epoch ms。 */
export interface GroupRoute {
  groupLabel: string;
  chatId: string;
  updatedBy: string | null;
  updatedAt: number;
}

/** 写路由结果：诚实可区分——写入 / 清除（route=null）/ 无效键拒绝。 */
export type SetGroupRouteResult =
  | { ok: true; route: GroupRoute | null }
  | { ok: false; reason: 'invalid_key' };
