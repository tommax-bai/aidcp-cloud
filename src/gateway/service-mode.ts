/**
 * Block② 2d 第一步：多进程运行模式的**纯选择器**（一套代码、多入口）。
 *
 * 同一 `src/` 树、同一组合根 `main()`，靠环境变量 `AIDCP_SERVICE` 决定「跑哪些组合根段、
 * 起哪些监听」。本文件**只做纯映射**（env → 计划），不 import 任何业务模块、不起任何进程、
 * 无任何副作用 —— 因此可被单元测试直接 import 断言，不会拉起 `main()`、不碰网络/DB。
 *
 * ## 模式（2026-08-04 起：单体只剩一种）
 *   - `monolith`（默认 / env 未设 / 未识别值）：四段全跑，无新监听，网关默认 local。
 *     **这是 dev 安全底线：AIDCP_SERVICE 未设时 main() 跑法与拆分前逐字节等价。**
 *     它同时是 **OL 的生产形态**与 **dev 的回滚路径**，两处都不设 `AIDCP_SERVICE`。
 *   - ~~`content` / `automation` / `api` / `core`~~ —— **已退役**（change
 *     `deploy-derived-services-to-dev` task 8.0），改由各自派生仓承担；以这四个名字启动单体
 *     一律 fail-closed 抛错，MUST NOT 回落。理由与去处见 {@link RETIRED_ROLE_MODES}。
 *
 * ## 下面那几个 `xxxForMode` 分段函数为什么还留着
 * 退役之后 {@link serviceModeFromEnv} 恒返回 `monolith`，故它们的非 monolith 分支在**运行时已不可达**。
 * 保留是刻意的：一来这些分支里记着「哪个形态下谁有消费者」这类**判据本身**（尤其
 * {@link panelEventTransportForMode} 与 {@link outboxRetentionForMode} 的那两张表），
 * 删掉等于把结论连同理由一起丢；二来把它们连根拔起要同时改组合根十余处，
 * 而单体正是 OL 生产 + dev 回滚路径 —— **那是一次独立的重构，不该搭在退役这一批里**。
 * 已登记为后续清理项（见本 change task 8.0 的注记）。
 *
 * ## 为什么放在 src/gateway/（api 层）而非 composition
 * composition 白名单只含 `server.ts` / `index.ts`（组合根本体），不容纳新文件。本文件是**零依赖纯
 * 函数**：只被组合根 import（composition → 任意层恒允许），自身不产生任何跨层边，故落在 gateway
 * 目录（inherit=api）对边界棘轮 `frozenTotal` 零影响。它与同目录的数据网关同属 Block② 收口件。
 */

/** 运行模式。未识别值一律回落 `monolith`（安全底线）。 */
export type ServiceMode = 'monolith' | 'content' | 'automation' | 'api' | 'core';

/**
 * **按角色切段的四个模式已于 2026-08-04 退役**（change `deploy-derived-services-to-dev` task 8.0）。
 *
 * 它们是「一套代码、多入口」那个过渡形态的产物：同一份 `src/` 靠 `AIDCP_SERVICE` 决定跑哪几段。
 * 拆仓完成后，这几个角色改由**各自的派生仓**承担（各有自己的手写入口与启动守卫），
 * 单体只剩 `monolith` 一种跑法 —— 它同时是 OL 的生产形态与 dev 的回滚路径。
 *
 * ## 为什么是「显式拒启动」而不是「回落 monolith」
 * 回落等于：**有人要求按角色切段，进程却静默起成了完整单体** —— 连带抢走自动化写者锁、
 * 占住边-云 8787。那是本仓的「静默假成功」红线：调用方拿到的是「起来了」，
 * 实际起来的是另一个东西。故这四个名字一律 fail-closed，并具名指向该去的地方。
 *
 * 未识别的**其它**值仍回落 `monolith`（既有安全底线，本次不动）。
 */
const RETIRED_ROLE_MODES: ReadonlyMap<string, string> = new Map([
  ['content', '派生仓 aidcp-content（入口 src/content-service-entry.ts）'],
  ['automation', '派生仓 aidcp-automation（入口 src/server.ts，且硬要求 AIDCP_SERVICE=automation）'],
  ['api', '派生仓 aidcp-api（入口 src/api-service-entry.ts，且硬要求 AIDCP_SERVICE=api）'],
  [
    'core',
    'core 没有对应派生仓 —— 它是 automation+api 合进一个进程的过渡形态，已随拆仓一并取消；'
      + '要这两个角色请分别起 aidcp-automation 与 aidcp-api',
  ],
]);

/** 以已退役的角色模式启动单体时抛出。**具名、可执行**：直接说清该去哪个派生仓。 */
export class RetiredServiceModeError extends Error {
  // 具名字段而非只靠 instanceof：本仓的错误会跨进程/跨包传，`instanceof` 在那两条路径上恒 false。
  override readonly name = 'RetiredServiceModeError';

  constructor(
    /** 请求的那个已退役模式名。 */
    readonly requestedMode: string,
    /** 该角色现在由谁承担。 */
    readonly successor: string,
  ) {
    super(
      `AIDCP_SERVICE=${requestedMode} 已退役：单体不再支持按角色切段启动，请改用 ${successor}。`
        + '（本进程 fail-closed 退出，MUST NOT 回落成完整单体 —— 那会静默抢走自动化写者锁与边-云 8787。）',
    );
  }
}

/** 组合根四段的运行计划：给定模式，哪些段该跑。segA(基础)恒跑。 */
export interface SegmentPlan {
  /** segA 基础层（DB 池 / LLM / 存储 / 配置镜像）—— 所有模式恒跑。 */
  segA: boolean;
  /** segB content（精选库 / 发布后处理 / 人设 / 账号 / eventBus 等前置构造）。 */
  segB: boolean;
  /** segC automation（边缘 WS server、风控、编排、通知巡视）。 */
  segC: boolean;
  /** segD apiServing（面板 API、客户鉴权、飞书接收、数据网关收口）。 */
  segD: boolean;
}

/** 监听计划：给定模式，起哪些独立监听。 */
export interface ListenerPlan {
  /**
   * content 进程独占的内部 HTTP 读 API（curated-content 读端点）。
   * 仅 content 模式起；monolith / core 不起（monolith 走进程内本地实例，core 经网关远程取）。
   */
  contentReadApi: boolean;
  /**
   * 常规监听（边缘 WS 8787 / 面板 / 客户鉴权 / 飞书）由 segC/segD 内部按各自 env 门控启动。
   * 此字段只标记「本模式是否运行承载这些监听的段」，具体端口仍由段内 env 决定。
   */
  automationAndApi: boolean;
}

/**
 * 从 env 解析运行模式。**单体只剩 `monolith` 一种跑法**：未设、空串、任何未识别值都回落
 * `monolith`（既有安全底线）；而 `content` / `automation` / `api` / `core` 这四个**已退役**的
 * 角色名 **MUST 抛 {@link RetiredServiceModeError}**，MUST NOT 回落 —— 理由见 {@link RETIRED_ROLE_MODES}。
 */
export function serviceModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  key = 'AIDCP_SERVICE',
): ServiceMode {
  const raw = env[key];
  if (typeof raw === 'string') {
    const successor = RETIRED_ROLE_MODES.get(raw);
    if (successor !== undefined) throw new RetiredServiceModeError(raw, successor);
  }
  return 'monolith';
}

/** 给定模式 → 该跑哪些组合根段。segA 恒跑。 */
export function segmentsForMode(mode: ServiceMode): SegmentPlan {
  switch (mode) {
    case 'content':
      return { segA: true, segB: true, segC: false, segD: false };
    case 'automation':
      return { segA: true, segB: false, segC: true, segD: false };
    case 'api':
      return { segA: true, segB: false, segC: false, segD: true };
    case 'core':
      return { segA: true, segB: false, segC: true, segD: true };
    case 'monolith':
    default:
      return { segA: true, segB: true, segC: true, segD: true };
  }
}

/** 给定模式 → 起哪些独立监听。contentReadApi 仅 content 模式起。 */
export function listenersForMode(mode: ServiceMode): ListenerPlan {
  switch (mode) {
    case 'content':
      return { contentReadApi: true, automationAndApi: false };
    case 'automation':
    case 'api':
    case 'core':
      return { contentReadApi: false, automationAndApi: true };
    case 'monolith':
    default:
      return { contentReadApi: false, automationAndApi: true };
  }
}

/**
 * publish approval decision/store 的物理属主门禁。
 * 拆分进程时只有 api 构造属主存储；core/monolith 因包含 api 段而保留进程内权威。
 */
export function ownsPublishApprovalAuthorityForMode(mode: ServiceMode): boolean {
  return mode === 'api' || mode === 'core' || mode === 'monolith';
}

/**
 * Feishu inbound/outbound is API-owned. Content reaches its publish-card exit
 * through the existing API HTTP port; automation only emits structured
 * notification commands and therefore must not load the SDK or API card stack.
 */
export function ownsApiFeishuForMode(mode: ServiceMode): boolean {
  return mode === 'api' || mode === 'core' || mode === 'monolith';
}

/** content 进程内部 HTTP 读 API 的默认监听端口（可由 `AIDCP_CONTENT_PORT` 覆盖）。 */
export const DEFAULT_CONTENT_READ_API_PORT = 8092;

/* ───────────────────── 面板事件旁路：写哪边、读哪边（模式感知） ───────────────────── */

/** 面板事件跨段传输计划：本模式是否 tee 到 outbox、是否从 outbox 回放。 */
export interface PanelEventTransportPlan {
  /** 是否把本进程的编排事件 tee 进 `event_outbox`（写方）。 */
  tee: boolean;
  /** 是否从 automation-owned `event_outbox` 回放并主动投递到 api ingress。 */
  replay: boolean;
}

/**
 * 面板事件旁路的**唯一门禁**：一条编排事件该不该落进共库的生产 PostgreSQL。
 *
 * 判据只有一条：**面板推送端（panel-ws，跑在 segD）是否与事件产生端（EventBus，跑在 segC）在同一个进程**。
 * 同进程 ⇒ 面板直接订阅总线就拿到了，tee 写出去的行**没有任何消费者**，是纯废行。
 *
 *   | 模式       | 段            | 面板在哪                | tee   | replay |
 *   | ---------- | ------------- | ----------------------- | ----- | ------ |
 *   | monolith   | A+B+C+D       | 同进程（直连总线）      | 否    | 否     |
 *   | content    | A+B           | 不在本进程，也无产生端  | 否    | 否     |
 *   | automation | A+C           | **另一个进程（api）**   | **是**| **是** |
 *   | api        | A+D           | 本进程，但无产生端      | 否    | 否     |
 *   | core       | A+C+D         | 同进程（直连总线）      | 否    | 否     |
 *
 * `core` 那一行是本函数存在的直接原因：它此前满足「非 monolith」于是照写不误，而回放门禁只在 `api`
 * 模式开 ⇒ 每一条编排事件都被写进生产库、没有任何消费者、也没有任何剪裁。
 *
 * **刻意不照抄推送端那道「本进程有无已认证订阅者就短路」的闸**：拆进程后消费方（api 进程）的订阅者
 * 对 automation 进程不可见，照抄就成了静默漏投——面板一打开就发现事件流是断的。跨进程能安全依据的
 * 只有「消费方这个角色在本部署形态里是否存在」，即模式本身。
 */
export function panelEventTransportForMode(mode: ServiceMode): PanelEventTransportPlan {
  switch (mode) {
    case 'automation':
      return { tee: true, replay: true };
    case 'api':
      return { tee: false, replay: false };
    case 'core':
    case 'content':
    case 'monolith':
    default:
      return { tee: false, replay: false };
  }
}

/** `event_outbox` 保留期剪裁计划：谁来剪、剪的时候要等谁追平。 */
export interface OutboxRetentionPlan {
  /** 本进程是否负责剪裁（须持有 automation 属主连接，即跑了 segC 的模式）。 */
  prune: boolean;
  /** `panel.event` 在本形态下**是否真的有消费者**（有 ⇒ 剪裁必须等它的进度）。 */
  panelEventConsumed: boolean;
  /** `risk.command` 在本形态下是否真的有消费者（单写者随 segC 起）。 */
  riskCommandConsumed: boolean;
}

/**
 * 谁剪、等谁。**「本形态下有没有消费者」必须由模式决定，而不是由「游标行在不在」倒推**：
 * 没有消费者的模式（core 的 panel.event、monolith 的两个主题）永远不会出现游标行，若把「所有声明的
 * 消费者都有进度行」当剪裁前提，那些模式会**永久拒绝剪裁 + 永久告警**——闸变成噪声源加磁盘炸弹。
 *
 * 剪裁只在跑了 segC 的模式做（`event_outbox` 属 automation，api / content 进程不该写它）。
 */
export function outboxRetentionForMode(mode: ServiceMode): OutboxRetentionPlan {
  switch (mode) {
    case 'automation':
      // 面板在另一个进程回放；风控单写者在本进程消费。两者都要等进度。
      return { prune: true, panelEventConsumed: true, riskCommandConsumed: true };
    case 'core':
      // 面板同进程直连 ⇒ panel.event 无消费者（含此前误写下的历史行，纯按年龄剪）；风控单写者在本进程。
      return { prune: true, panelEventConsumed: false, riskCommandConsumed: true };
    case 'monolith':
      // 两条 outbox 通道都不接线（既不写也不消费）；仍负责把历史遗留行剪干净。
      return { prune: true, panelEventConsumed: false, riskCommandConsumed: false };
    case 'api':
    case 'content':
    default:
      return { prune: false, panelEventConsumed: false, riskCommandConsumed: false };
  }
}
