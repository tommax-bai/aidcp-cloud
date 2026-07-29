/**
 * automation → content 跨属主读写的**统一结果信封**（kernel）。
 *
 * 存在理由只有一条：**「对面明确回答了空」与「没问到对面」MUST 可区分。**
 * 单体里这两者天然同形也无害——存储对象就在同一个进程里，拿不到就是真没有。拆进程之后它们
 * 是两件完全不同的事，而现役代码恰恰把它们压成了同一个值：
 *   - `src/server.ts:7024` 的 `: Promise.resolve([])`（精选库没接线 → 空数组）；
 *   - `src/comment-agent/comment-scheduler.ts:1603` 的 `.catch(() => [])`（读失败 → 空数组）；
 *   - `src/orchestrator/role-dispatcher.ts:2456` 的「PG 不可用 / 装载失败 → 回退空池」。
 * 跨进程后这三处会把「连不上内容域」原样吃成「没有精选素材」「概念池是空的」，
 * 于是搜索词生成拿零样本照跑、发帖创作以为没素材照发、浏览闭环以为池空照走 seed —— 全是本仓红线
 * 点名的静默假成功：缺席被压成了空值，没有任何一处会报错。
 *
 * 所以本信封**不禁止降级**，只要求降级是调用方看着具名原因**明写**出来的一个决定，
 * 而不是一个 `catch` 顺手吃掉的副产物。
 *
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 */

/**
 * 具名失败原因：**判定只许看这个字段**，MUST NOT 看 `detail` 文案、更 MUST NOT 用 `instanceof`
 * （§8.5：跨进程后 `instanceof` 恒 false，错误识别一律走结构化守卫）。
 */
export type ContentPortFailureReason =
  /** 连不上内容域（进程未起 / 网络不通 / 连接被拒）。 */
  | 'unreachable'
  /** 连上了，但对面没在预算内回答。**与「对面回答了空」是两回事。** */
  | 'timeout'
  /** 对面明确回了一个错误（它的库读不到、它自己抛了）。 */
  | 'remote_error'
  /** 对面回了，但形状不符本契约——跨进程契约漂移（§8.1 的 kernel pin 漂移就长这样：编译过、跑起来才错）。 */
  | 'malformed_response'
  /**
   * 对面接线了、但不提供这个方法（版本落后 / 路由未注册）。
   *
   * 它是**回落分支唯一合法的触发条件**。今天 automation 侧用 `typeof x.m === 'function'` 探能力
   * （见 `SchedulerConceptStore.getNewConceptsWithSourceSince?` 的可选签名），
   * 那个探针跨进程后**恒为真**——客户端类总是定义着方法——回落分支就此变成死代码，
   * 真正的能力缺口反而被静默吞掉。要回落就按这个原因回落。
   */
  | 'unsupported_method'
  /**
   * 本进程侧压根没配置这条端口（单体里等价于那个存储对象是 `undefined`）。
   * §8.5 的「响亮取用闸」：缺席 MUST 被说出来，MUST NOT 被 `?.` 静默吞成一个成功的空结果。
   */
  | 'not_configured';

export interface ContentPortFailure {
  outcome: 'unavailable';
  reason: ContentPortFailureReason;
  /** 人可读细节，仅供日志 / 告警。**MUST NOT 参与任何判定**（文案会变，原因码不会）。 */
  detail?: string;
}

/** 成功 = 对面明确回答了，`value` 就是它的回答（**包括「空」这个回答**）。 */
export type ContentPortResult<T> = { outcome: 'ok'; value: T } | ContentPortFailure;

/**
 * 结构化守卫（§8.5）：按 `outcome` 这个具名字段判，不依赖原型链。
 * 跨进程后错误对象是 JSON 反序列化出来的裸对象，`instanceof` 恒 false。
 */
export function isContentPortFailure<T>(result: ContentPortResult<T>): result is ContentPortFailure {
  return result.outcome === 'unavailable';
}
