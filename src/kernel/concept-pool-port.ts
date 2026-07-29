/**
 * 概念池的**跨属主端口面**（kernel，automation → content）。
 *
 * 概念池的存储是 content 属主（`src/cache/concept-store.ts`，表 `concepts`），
 * 消费方全在 automation：浏览闭环的调度器、概念抽取角色、发帖调度器。
 * 单体里 automation 直接持着那个存储对象调方法；拆进程后 automation 库里没有 `concepts` 表，
 * 这几条调用只能经本端口过去。
 *
 * **六个方法就是全部消费面**，逐条对得上真实调用点（没有消费者的方法一个都不开）：
 *   - `addCandidate`   ← `src/agents/concept-extractor-role.ts:88`（经其 `ConceptSink` 窄契约）
 *   - `loadPool`       ← `src/orchestrator/role-dispatcher.ts:2464`（会话启动装载概念池快照）
 *   - `markSearched`   ← `src/orchestrator/role-dispatcher.ts:3411` / `:3714`（下发搜索后 / 回执后各一处）
 *   - `countNewSince`  ← `src/publish-agent/publish-scheduler.ts:263` / `:323`（聚合输入 + 概念积累扳机）
 *   - `getNewConceptsWithSourceSince` ← `publish-scheduler.ts:255`（带来源笔记标题的富方法）
 *   - `getNewConceptsSince`           ← `publish-scheduler.ts:257`（**上一条的回落分支**）
 *
 * **那条回落分支 MUST 留在端口面上。** 它平时不走，只在富方法不可用时才走——恰恰因此，
 * 漏掉它不会在任何一次正常运行里暴露，只会在回落发生的那一刻炸。
 * 但**回落的触发方式必须换**：今天写的是 `this.d.conceptStore.getNewConceptsWithSourceSince ? … : …`，
 * 一个 `typeof` 能力探针；跨进程后客户端类总是定义着这个方法，探针恒为真、回落变死代码、
 * 真实的能力缺口被静默吞掉。改用 `unsupported_method` 这个具名原因驱动回落，
 * 故本端口上**两个方法都是必选**、不带 `?`。
 *
 * **失败语义**：一律经 `ContentPortResult` 交出，读失败 MUST NOT 被翻译成「池是空的 / 没有新概念」。
 * 现役的两处降级——调度器「装载失败 → 回退空池」、抽取角色「写失败只记日志」——本身是合理的
 * （不能让概念池拖垮浏览闭环），但拆进程后它们 MUST 变成调用方**看着具名原因明写**的决定，
 * 而不是 `catch` 顺手吃掉的副产物。
 *
 * 零 import 副作用、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 */
import type { ConceptPool } from './concept-pool.js';
import type { ContentPortResult } from './content-port-result.js';

/**
 * 一条新概念及其来源笔记标题（形状照抄属主存储的真实返回，不另造更宽松的一套）。
 * `sourceNote` 缺失落 `null`，**不编造**——空字符串会让下游把「不知道从哪来的」写成「来自无标题笔记」。
 */
export interface ConceptWithSource {
  keyword: string;
  sourceNote: string | null;
}

/**
 * 写口回执：**只回报真实影响行数**。
 *
 * `addCandidate` 撞唯一键 → 0（该词早就在池里），真插入 → 1；`markSearched` 是 upsert，恒 1。
 * 客户端 MUST NOT 因为「请求发出去了」就填一个 1 —— 那正是红线点名的静默假成功：
 * 抽取角色靠这个数判「这个词是不是我新发现的」，填错会让它把老词当新词一路报上去。
 */
export interface ConceptWriteAck {
  affectedRows: number;
}

export interface ConceptPoolPort {
  /**
   * 新增一个候选概念（已存在则不动，保留原状态）。
   * 回执带真实影响行数；调用方按 `affectedRows > 0` 判「这次真的是新词」。
   */
  addCandidate(keyword: string, sourceNote?: string): Promise<ContentPortResult<ConceptWriteAck>>;

  /** 装载整池快照（已搜过 / 已知 → known，未搜 → candidates）。 */
  loadPool(): Promise<ContentPortResult<ConceptPool>>;

  /** 标记某概念已搜索（不存在则以 searched 插入）。 */
  markSearched(keyword: string): Promise<ContentPortResult<ConceptWriteAck>>;

  /** 自某时刻起新发现的概念**数量**（发帖调度器的概念积累扳机按它判阈值）。 */
  countNewSince(sinceMs: number): Promise<ContentPortResult<number>>;

  /**
   * 自某时刻起新发现的概念关键词。
   * **这是 `getNewConceptsWithSourceSince` 的回落分支**，只在后者回 `unsupported_method` 时调用。
   */
  getNewConceptsSince(sinceMs: number, limit?: number): Promise<ContentPortResult<string[]>>;

  /** 自某时刻起新发现的概念关键词 + 各自来源笔记标题（发帖创作的首选取法）。 */
  getNewConceptsWithSourceSince(
    sinceMs: number,
    limit?: number,
  ): Promise<ContentPortResult<ConceptWithSource[]>>;
}
