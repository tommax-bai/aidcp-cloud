/**
 * automation → content 跨属主端口的**失败信号**（kernel）。
 *
 * 本文件取代上一轮的结果信封 `ContentPortResult<T>`（`content-port-result.ts`，已删）。
 * 那个信封的**目的**是对的（「对面明确回答了空」与「没问到对面」MUST 分得开），**落点**是错的：
 * 本仓既有的跨属主端口范式**全是**「客户端 implements 同一个 kernel 接口、返回裸值、失败靠抛」——
 * 见 {@link file://./publish-log-writer-port.ts}、{@link file://./curated-content-types.ts} 的
 * `CuratedContentReader` 及其已在跑的 HTTP 实现。信封是这一层里唯一的第二套约定，
 * 实际后果是接线的人顺手照抄既有范式，装了信封的那几个端口被**整体绕过**。
 * 故统一到既有约定：**端口返回裸值，失败抛本文件的错误**。
 *
 * 「分得开」这个目的没有丢，只是换了载体：**抛出本来就不是空数组**。真正的病根在吞点——
 *   - `src/server.ts:7024` 的 `: Promise.resolve([])`（精选库没接线 → 空数组）；
 *   - `src/comment-agent/comment-scheduler.ts:1603` 的 `.catch(() => [])`（读失败 → 空数组）；
 *   - `src/orchestrator/role-dispatcher.ts:2456` 的「装载失败 → 回退空池」。
 * 这三处同进程里无害（存储对象就在本进程，拿不到就是真没有），拆进程后会把「连不上内容域」
 * 原样吃成「没有精选素材 / 概念池是空的」：搜索词生成拿零样本照跑、发帖创作以为没素材照发、
 * 浏览闭环以为池空照走 seed —— 全程零报错，正是本仓红线点名的静默假成功。
 * 本文件**不禁止降级**，只要求降级是调用方看着具名 `reason` **明写**出来的一个决定，
 * 而不是一个 `catch` 顺手吃掉的副产物。
 *
 * **判定 MUST 走结构化守卫，MUST NOT 用 `instanceof`**（§8.5：跨进程后错误是 JSON 反序列化出来的
 * 裸对象，原型链上什么都没有；且 kernel 在拆仓期同时存在「仓内 src/kernel」与「包 aidcp-kernel」
 * 两份副本，同进程里类身份一样不可靠）。守卫形状逐字照既有判例
 * {@link file://./facebook-publish-media-types.ts}：具名 name 常量 + 最小可识别形状 + `is` 守卫，
 * 只看实例**自有的可枚举属性**。
 *
 * **为什么不复用既有的那两个错误**：
 *   - `CuratedContentUnavailableError`（curated-content-types.ts）只表达「精选表缺失」这一种原因，
 *     且今天三处 api 调用点靠 `instanceof` 认它。它给不出 `unsupported_method`——
 *     而概念池富方法的回落分支**只能**靠这个原因驱动（见 concept-pool-port.ts 的说明）。
 *   - `FacebookPublishMediaErrorShape` 是素材池专用的 name，借用等于说谎。
 * 故只在这里定义一次，两条 content 端口共用；**MUST NOT 再造第三套**。
 *
 * 零 import、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */

/** 具名失败原因：**判定只许看这个字段**，MUST NOT 看 `detail` 文案（文案会变，原因码不会）。 */
export const CONTENT_PORT_FAILURE_REASONS = [
  /** 连不上内容域（进程未起 / 网络不通 / 连接被拒）。 */
  'unreachable',
  /** 连上了，但对面没在预算内回答。**与「对面回答了空」是两回事。** */
  'timeout',
  /** 对面明确回了一个错误（它的库读不到、它自己抛了）。 */
  'remote_error',
  /** 对面回了，但形状不符本契约——跨进程契约漂移（§8.1 的 kernel pin 漂移就长这样：编译过、跑起来才错）。 */
  'malformed_response',
  /**
   * 对面接线了、但不提供这个方法（版本落后 / 路由未注册）。
   *
   * 它是**回落分支唯一合法的触发条件**。今天 automation 侧用 `typeof x.m === 'function'` 探能力，
   * 那个探针跨进程后**恒为真**——客户端类总是定义着方法——回落分支就此变成死代码，
   * 真正的能力缺口反而被静默吞掉。要回落就按这个原因回落。
   */
  'unsupported_method',
  /**
   * 本进程侧压根没配置这条端口（单体里等价于那个存储对象是 `undefined`）。
   * §8.5 的「响亮取用闸」：缺席 MUST 被说出来，MUST NOT 被 `?.` 静默吞成一个成功的空结果。
   */
  'not_configured',
] as const;

export type ContentPortFailureReason = (typeof CONTENT_PORT_FAILURE_REASONS)[number];

export function isContentPortFailureReason(value: unknown): value is ContentPortFailureReason {
  return typeof value === 'string' && (CONTENT_PORT_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * 错误类的 `name` 取值——**跨进程识别键**，构造时 MUST 逐字写入实例。
 * 它必须是实例自有的可枚举属性：Error 子类不显式赋 name 时继承的是 `'Error'`，序列化后什么都不剩。
 */
export const CONTENT_PORT_ERROR_NAME = 'ContentPortError';

/** 线上 `code` 的前缀。完整取值恒为 `content_port_<reason>`。 */
export const CONTENT_PORT_ERROR_CODE_PREFIX = 'content_port_';

/** 由 reason 生成线上 code。两侧共用这一个函数，防止各拼各的。 */
export function contentPortErrorCode(reason: ContentPortFailureReason): string {
  return `${CONTENT_PORT_ERROR_CODE_PREFIX}${reason}`;
}

/**
 * 由线上 code 还原 reason；**还原不出来返回 `null`，绝不套默认值**。
 *
 * 为什么需要它：内部 HTTP 传输把抛出物编码成线格式时只保 `code` + `message`
 * （带 string `code` 的抛出物按 code 原样透传，否则一律记成 `handler_error`），
 * `name` / `reason` 两个字段跨那一跳会全部丢失，客户端侧拿到的是传输层自己的错误对象。
 * 传输适配层 MUST 用本函数把 code 还原成 reason 后重新抛出 {@link ContentPortError}；
 * 还原不出来时 MUST 显式判成 `remote_error` 并把原始 code 写进 `detail`，
 * MUST NOT 默默套一个默认 reason —— 那会让「不提供这个方法」被吞成「对面报错了」，
 * 概念池的回落分支再次变成死代码。
 */
export function contentPortReasonFromCode(code: unknown): ContentPortFailureReason | null {
  if (typeof code !== 'string' || !code.startsWith(CONTENT_PORT_ERROR_CODE_PREFIX)) return null;
  const reason = code.slice(CONTENT_PORT_ERROR_CODE_PREFIX.length);
  return isContentPortFailureReason(reason) ? reason : null;
}

/**
 * 跨进程边界上 content 端口错误的**最小可识别形状**（序列化往返后仍成立的两字段）。
 *
 * `reason` 故意收成 `string` 而不是 {@link ContentPortFailureReason}：跨进程来的取值不受本进程枚举
 * 约束，收窄成闭集合会让「没见过的原因」再次退化回兜底处置。未知取值由调用方**原样记录并按不可用
 * 处置**，MUST NOT 当成「对面回答了空」。
 */
export interface ContentPortErrorShape {
  name: typeof CONTENT_PORT_ERROR_NAME;
  reason: string;
  /** 出错的端口方法，形如 `concept-pool.loadPool`。仅供日志 / 告警定位。 */
  operation?: string;
  /** 线上 code（`content_port_<reason>`）。 */
  code?: string;
  /** 人可读细节。**MUST NOT 参与任何判定。** */
  detail?: string;
}

/**
 * 结构化识别 content 端口错误。**同进程实例与跨进程反序列化对象一视同仁。**
 */
export function isContentPortError(e: unknown): e is ContentPortErrorShape {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { name?: unknown; reason?: unknown };
  return o.name === CONTENT_PORT_ERROR_NAME && typeof o.reason === 'string' && o.reason !== '';
}

/**
 * content 端口的失败抛出物。属主侧实现、传输适配层、以及「本进程没配置这条端口」的响亮取用闸
 * 都抛它；调用方一律用 {@link isContentPortError} 识别，按 `reason` 决定降不降级。
 */
export class ContentPortError extends Error {
  /** 线上 code，恒为 `content_port_<reason>`——见 {@link contentPortReasonFromCode}。 */
  readonly code: string;

  constructor(
    readonly reason: ContentPortFailureReason,
    readonly operation: string,
    readonly detail?: string,
  ) {
    super(detail ? `${operation}: ${reason} (${detail})` : `${operation}: ${reason}`);
    // 跨进程识别键：MUST 是实例自有的可枚举属性（见文件头）。
    this.name = CONTENT_PORT_ERROR_NAME;
    this.code = contentPortErrorCode(reason);
  }
}
