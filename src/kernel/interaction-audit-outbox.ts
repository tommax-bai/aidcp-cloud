/**
 * 互动域配置面审计（`interaction_audit_events`）的**跨属主投递契约**（Block③ 物理拆库 L3）。
 *
 * ## 为什么不能像同文件的 DELETE 那样直接走写端口
 *
 * `interaction_audit_events` 属 **api** 单写（`boundaries/table-ownership.json`）。
 * automation 的 `InteractionStore.audit()` 历史上直接 `INSERT` 这张 api 属主表 —— 那是真边界违规。
 * 同文件的过期 DELETE 已经收口到 `InteractionApiPurgePort`，但 INSERT **不能照抄**：
 * 实测 7 个内部调用点里有 **4 个把调用方的事务句柄传了进来**（登录态首写 / 同步批次入库 /
 * 回复结果落库 / 测试数据重置），也就是说这笔 INSERT 与 automation 的业务写**在同一笔事务里**。
 * 拆库后那就是一笔**跨库事务**，端口解决不了（端口只能换连接，换不掉「两个库要一起提交」）。
 *
 * 故按最终一致改造：**automation 本域 outbox（`event_outbox`，automation 属主）+ 中继 +
 * api 侧幂等落审计**。事务型 outbox 的语义正好补上端口补不了的那一块 ——
 * 业务回滚 ⇒ 审计事件不存在；业务提交 ⇒ 审计事件必然已入队，绝不出现「审计写了、业务没落」
 * 或「业务落了、审计凭空消失」。
 *
 * ## 幂等由主键承担
 *
 * outbox 是 at-least-once，同一条可能被投递多次。`interaction_audit_events.event_id` 本就是
 * **TEXT PRIMARY KEY**，且由 automation 侧在**入队时**生成并随载荷带过来，故 api 侧落地用
 * `ON CONFLICT (event_id) DO NOTHING` 即天然幂等。事件 id MUST NOT 由中继侧现生成 ——
 * 那样重放就会变成重复插入。
 *
 * ## 时间戳
 *
 * `createdAt` 是**业务发生时刻**（automation 侧入队时取），不是中继落地时刻。若用落地时刻，
 * 审计时间线会随中继延迟漂移，`purgeExpiredContent` 的 365 天保留期也会跟着漂。
 */

/** 固定 outbox 主题；emit 侧与中继侧共用，避免字面量漂移。 */
export const INTERACTION_AUDIT_OUTBOX_TOPIC = 'interaction.audit_event';

/** 中继消费者名（游标按 (consumer, target) 分行）。 */
export const INTERACTION_AUDIT_RELAY_CONSUMER = 'interaction-audit-relay';

/**
 * 已被中继追平的 outbox 行的保留期：24 小时。
 *
 * outbox 是队列不是账本 —— 审计的**账本**是 `interaction_audit_events` 本身（api 属主、365 天保留）；
 * 队列里留一天只是给「中继短暂离线后追赶 + 事后排障看得到原始信封」留余量。
 *
 * **MUST NOT 给本主题设 `unconsumedRetentionMs` 兜底强删**：这是承重的命令类主题，未被中继应用就删掉
 * 等于静默吞掉一条审计。宁可让 outbox 涨、并由剪裁器如实报 `blockedBy`。
 */
export const INTERACTION_AUDIT_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 一条待投递的配置面审计行。字段与 `interaction_audit_events` 的列一一对应。 */
export interface InteractionAuditEventRecord {
  /** 目标表主键；MUST 由 automation 侧入队时生成（幂等键，见文件头）。 */
  eventId: string;
  platform: string;
  accountId: string;
  envKey: string | null;
  actor: string;
  action: string;
  configVersion: number | null;
  entityType: string;
  entityId: string | null;
  summary: string;
  labels: Record<string, unknown>;
  /** 业务发生时刻（epoch ms），不是中继落地时刻。 */
  createdAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * 解码一条 outbox 载荷。**结构不符返回 `null`，绝不「尽力而为」地补默认值** ——
 * 补出来的审计行是伪造的事实，比缺一条审计更糟。
 *
 * 调用方（中继）拿到 `null` 时 MUST 抛错让消费游标停在该条之前：这样这条坏载荷会在每一轮
 * 轮询里如实报一次错、被人看见，而不是被静默跳过。代价是队列会被这条堵住 —— 这正是我们要的
 * 可见性：本载荷由本仓自己的 emit 侧生成，结构不符即代码缺陷，不该靠丢数据来掩盖。
 */
export function decodeInteractionAuditEvent(payload: unknown): InteractionAuditEventRecord | null {
  if (!isPlainObject(payload)) return null;
  const {
    eventId, platform, accountId, envKey, actor, action, configVersion,
    entityType, entityId, summary, labels, createdAt,
  } = payload;
  if (typeof eventId !== 'string' || eventId === '') return null;
  if (typeof platform !== 'string' || typeof accountId !== 'string') return null;
  if (!optionalString(envKey)) return null;
  if (typeof actor !== 'string' || typeof action !== 'string') return null;
  if (!(configVersion === null || typeof configVersion === 'number')) return null;
  if (typeof entityType !== 'string' || !optionalString(entityId)) return null;
  if (typeof summary !== 'string' || !isPlainObject(labels)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return {
    eventId, platform, accountId, envKey, actor, action, configVersion,
    entityType, entityId, summary, labels, createdAt,
  };
}
