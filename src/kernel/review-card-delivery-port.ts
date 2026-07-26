/**
 * 「候审卡要不要发飞书」的跨属主判定口（kernel）。
 *
 * 判定本身要读两张 **api 属主**表——账号分组的稿件投递策略、以及该账号的客户审批归属是否可证。
 * 内容域只需要一个 yes/no 加一个原因，不需要那两张表，也不该为它们持有 api 库的连接。
 * 故把整段判定留在 api 侧，跨边界只走这一个方法。
 *
 * **fail-open 是这条口的语义，不是容错兜底**：判不出来一律**保留飞书卡**。
 * 少发一张卡 = 一篇稿子没人知道要审；多发一张卡 = 有人多看一眼。方向只能朝后者倒。
 * 实现方与远程客户端 MUST 都遵守：任何异常（读库失败 / 跨进程不可达 / 超时）都回
 * `{ send: true, reason: … }`，**MUST NOT 抛给调用方**，更 MUST NOT 回 `send:false`。
 */

/** 判定结果。`reason` 只用于日志与审计，MUST 如实反映走到了哪一支，MUST NOT 归一成一个笼统值。 */
export interface ReviewCardDeliveryDecision {
  /** true = 照发飞书审批卡；false = 该账号走「只进客户端」策略且归属可证，本次不发。 */
  send: boolean;
  reason: string;
}

export interface ReviewCardDeliveryPort {
  resolveReviewCardDelivery(accountId: string): Promise<ReviewCardDeliveryDecision>;
}
