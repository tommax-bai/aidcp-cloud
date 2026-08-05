/**
 * `event_outbox` 主题的**穷举登记表**与保留期覆盖闸（change bound-event-outbox-growth）。
 *
 * ## 为什么需要它
 *
 * outbox 是队列不是账本。剪裁器（`OutboxRetentionPruner`）本身早就接了，
 * 但它按**主题名单**工作 —— 名单里没写的主题一行都不剪，而这件事**不报错、不告警、
 * 不体现在任何测试里**，只体现为共用生产库上的一张表在长。
 *
 * 实测代价（2026-08-05，dev）：`sync_read.changed` 与 `config_mirror.bump` 两条主题
 * 都漏在名单外。前者以每 target 每 10 秒一条的速度长到 8 万行，整表 141,245 行 / 45MB；
 * 后者九天才 17 行，所以一直没人看见 —— **它们是同一个缺口，只是产量不同**。
 * 两次都是靠人工查库发现的。
 *
 * ## 这道闸拦的是什么
 *
 * 照本仓既有范式（两份 `protocol.ts` 用 `Record<MessageType, true>` 穷举，漂移即 typecheck 失败）：
 *
 * - **类型层**：`EVENT_OUTBOX_RETENTION_ROSTER` 是 `Record<EventOutboxTopic, …>`。
 *   新增主题却不给保留裁定 ⇒ typecheck 当场失败。
 * - **验收层**：`assertOutboxRetentionCoverage` 拿**实际注册进剪裁器的主题**与本表对账。
 *   声明要剪却没有任何剪裁器登记它 ⇒ 失败；登记了本表没有的主题名 ⇒ 也失败
 *   （后者意味着某一侧名字写错了，那条主题实际无人剪裁）。
 *
 * **「确实不需要剪」MUST 在本表里显式写明理由，MUST NOT 靠在名单里缺席来表达。**
 * 缺席与遗漏在代码里同形，而同形的两件事迟早会被当成同一件。
 *
 * ## 主题名为什么在这里写成字面量
 *
 * 各主题常量分散在 kernel / transport / 业务模块里，把它们全 import 进来会在本文件上
 * 拉出一张跨属主的 import 图（拆仓期的 `boundaries` 规则对此敏感）。
 * 代价是**这是一份手抄名单** —— 手抄名单会与事实源漂移，本仓有前科。
 * 因此配套的验收用例 MUST 逐条断言本表的字面量 === 对应的导出常量（引用断言），
 * 光有本文件不算数。
 */

/** 登记在册的全部 outbox 主题名。新增主题 MUST 同时在此登记并给出保留裁定。 */
export const EVENT_OUTBOX_TOPIC_NAMES = {
  panelEvent: 'panel.event',
  riskCommand: 'risk.command',
  interactionAudit: 'interaction.audit_event',
  configMirrorBump: 'config_mirror.bump',
  syncReadChanged: 'sync_read.changed',
} as const;

export type EventOutboxTopic =
  (typeof EVENT_OUTBOX_TOPIC_NAMES)[keyof typeof EVENT_OUTBOX_TOPIC_NAMES];

export const EVENT_OUTBOX_TOPICS: readonly EventOutboxTopic[] = Object.values(
  EVENT_OUTBOX_TOPIC_NAMES,
);

/**
 * 一条主题的保留裁定。
 *
 * `prune: false` **不是**「没想好」的占位 —— 它是一个正式结论，必须带理由，
 * 且会被覆盖闸当作「本部署形态下确实无人剪它」来核对。
 */
export type OutboxRetentionDisposition =
  | {
      readonly prune: true;
      /** 为什么这样剪（保留期档位、按谁的游标、要不要强删）。 */
      readonly note: string;
    }
  | {
      readonly prune: false;
      /** 为什么不需要剪。缺理由的「不剪」与「漏了」同形，那正是本闸要消灭的形态。 */
      readonly reason: string;
    };

/**
 * 逐主题保留裁定。`Record<EventOutboxTopic, …>` 保证穷举：
 * 新增主题却不在这里给裁定，typecheck 直接失败。
 */
export const EVENT_OUTBOX_RETENTION_ROSTER: Readonly<
  Record<EventOutboxTopic, OutboxRetentionDisposition>
> = {
  'panel.event': {
    prune: true,
    note: '纯观测流：按回放消费者游标剪；回放端从未上线时另有兜底强删（强删会具名告警）。',
  },
  'risk.command': {
    prune: true,
    note: '承重命令：只按消费者游标剪，MUST NOT 设强删——未被应用就删掉 = 静默吞一次风控状态写。',
  },
  'interaction.audit_event': {
    prune: true,
    note: '承重：账本是接口侧那张审计表（365 天），outbox 只留 24h；同样禁强删。由审计中继那台剪裁器负责。',
  },
  'config_mirror.bump': {
    prune: true,
    note: '承重失效信号：按中继消费者游标剪，MUST NOT 设强删——删掉未投递的 = 一处配置永远不 reload。'
      + '产量极低（九天 17 行），但低产量不是免剪的理由，只是让缺口更晚被发现。',
  },
  'sync_read.changed': {
    prune: true,
    note: '变更通知（加速器，承重面是周期完整快照）：按中继消费者游标剪，短保留期即可；'
      + '不开强删口子——没有非开不可的理由，开了就是给将来留一条「消费者没上线也照删」的路。',
  },
};

/** 本表里声明「需要剪」的主题。 */
export function outboxTopicsRequiringRetention(): EventOutboxTopic[] {
  return EVENT_OUTBOX_TOPICS.filter(
    (topic) => EVENT_OUTBOX_RETENTION_ROSTER[topic].prune,
  );
}

/** 覆盖闸的对账结果；两个方向都要空才算过。 */
export interface OutboxRetentionCoverageReport {
  /** 声明要剪、却没有任何剪裁器登记它 —— 这条主题正在无界增长。 */
  readonly uncovered: string[];
  /** 剪裁器登记了、但本表没有 —— 名字写错或漏登记，同样意味着有主题无人剪。 */
  readonly unregistered: string[];
  /** 本表声明不剪、剪裁器却在剪 —— 裁定与实现不一致。 */
  readonly prunedDespiteDisposition: string[];
}

/**
 * 拿**实际注册进各剪裁器的主题**与本表对账。
 *
 * `registered` MUST 是本进程全部剪裁器主题的并集；只传其中一台的名单会让另一台负责的
 * 主题被误报成未覆盖，那是把一道闸变成噪声源。
 */
export function reviewOutboxRetentionCoverage(
  registered: readonly string[],
): OutboxRetentionCoverageReport {
  const seen = new Set(registered);
  const known = new Set<string>(EVENT_OUTBOX_TOPICS);
  return {
    uncovered: outboxTopicsRequiringRetention().filter((t) => !seen.has(t)),
    unregistered: [...seen].filter((t) => !known.has(t)).sort(),
    prunedDespiteDisposition: [...seen].filter(
      (t) =>
        known.has(t) &&
        !EVENT_OUTBOX_RETENTION_ROSTER[t as EventOutboxTopic].prune,
    ).sort(),
  };
}

/** 对账不过即抛，错误文案逐条点名（「有主题没剪」这件事 MUST NOT 只体现为一个布尔）。 */
export function assertOutboxRetentionCoverage(
  registered: readonly string[],
): void {
  const report = reviewOutboxRetentionCoverage(registered);
  const problems: string[] = [];
  if (report.uncovered.length > 0) {
    problems.push(
      `声明要剪却无人登记：${report.uncovered.join(', ')}`
        + '（这条主题会在 dev/ol 共用的生产库上无界增长，且不报错）',
    );
  }
  if (report.unregistered.length > 0) {
    problems.push(
      `剪裁器登记了登记表以外的主题名：${report.unregistered.join(', ')}`
        + '（名字写错或漏登记 —— 真正那条主题实际无人剪裁）',
    );
  }
  if (report.prunedDespiteDisposition.length > 0) {
    problems.push(
      `登记表裁定「不需要剪」却在剪：${report.prunedDespiteDisposition.join(', ')}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`event_outbox 保留期覆盖对账失败 —— ${problems.join('；')}`);
  }
}
