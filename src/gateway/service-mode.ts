/**
 * Block② 2d 第一步：多进程运行模式的**纯选择器**（一套代码、多入口）。
 *
 * 同一 `src/` 树、同一组合根 `main()`，靠环境变量 `AIDCP_SERVICE` 决定「跑哪些组合根段、
 * 起哪些监听」。本文件**只做纯映射**（env → 计划），不 import 任何业务模块、不起任何进程、
 * 无任何副作用 —— 因此可被单元测试直接 import 断言，不会拉起 `main()`、不碰网络/DB。
 *
 * ## 三模式
 *   - `monolith`（默认 / env 未设 / 未识别值）：四段全跑，无新监听，网关默认 local。
 *     **这是 dev 安全底线：AIDCP_SERVICE 未设时 main() 跑法与拆分前逐字节等价。**
 *   - `content`：跑 segA(基础)+segB(content)，跳过 segC/segD；segB 之后额外起一个
 *     内部 HTTP 读 API（承载 curated-content 读端点）。
 *   - `core`：跑 segA+segC+segD，跳过 segB；curated 读侧经数据网关走 HTTP（指向 content 进程）。
 *
 * ## 为什么放在 src/gateway/（api 层）而非 composition
 * composition 白名单只含 `server.ts` / `index.ts`（组合根本体），不容纳新文件。本文件是**零依赖纯
 * 函数**：只被组合根 import（composition → 任意层恒允许），自身不产生任何跨层边，故落在 gateway
 * 目录（inherit=api）对边界棘轮 `frozenTotal` 零影响。它与同目录的数据网关同属 Block② 收口件。
 */

/** 运行模式。未识别值一律回落 `monolith`（安全底线）。 */
export type ServiceMode = 'monolith' | 'content' | 'core';

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
 * 从 env 解析运行模式。**默认 `monolith`**：仅当 `AIDCP_SERVICE` 精确等于 `content` / `core`
 * 才切换；未设、空串、任何其它值都回落 `monolith`（未识别值不得静默改变默认行为）。
 */
export function serviceModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  key = 'AIDCP_SERVICE',
): ServiceMode {
  const raw = env[key];
  if (raw === 'content') return 'content';
  if (raw === 'core') return 'core';
  return 'monolith';
}

/** 给定模式 → 该跑哪些组合根段。segA 恒跑；content 跳 C/D；core 跳 B。 */
export function segmentsForMode(mode: ServiceMode): SegmentPlan {
  switch (mode) {
    case 'content':
      return { segA: true, segB: true, segC: false, segD: false };
    case 'core':
      return { segA: true, segB: false, segC: true, segD: true };
    case 'monolith':
    default:
      return { segA: true, segB: true, segC: true, segD: true };
  }
}

/** 给定模式 → 起哪些独立监听。 */
export function listenersForMode(mode: ServiceMode): ListenerPlan {
  switch (mode) {
    case 'content':
      return { contentReadApi: true, automationAndApi: false };
    case 'core':
      return { contentReadApi: false, automationAndApi: true };
    case 'monolith':
    default:
      return { contentReadApi: false, automationAndApi: true };
  }
}

/** content 进程内部 HTTP 读 API 的默认监听端口（可由 `AIDCP_CONTENT_PORT` 覆盖）。 */
export const DEFAULT_CONTENT_READ_API_PORT = 8092;
