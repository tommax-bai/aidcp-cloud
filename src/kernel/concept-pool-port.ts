/**
 * 概念池的**跨属主端口面**（kernel，automation → content）。
 *
 * 概念池的存储是 content 属主（`src/cache/concept-store.ts`，表 `concepts`）。
 * 单体里 automation 直接持着那个存储对象调方法；拆进程后 automation 库里没有 `concepts` 表，
 * 这几条调用只能经本端口过去。
 *
 * **六个方法就是全部消费面**，逐条对得上真实用法（没有消费者的方法一个都不开）：
 *   - `addCandidate`   ← automation 侧**只有接口声明、没有直接调用点**
 *     （`src/orchestrator/role-dispatcher.ts:139` 的 `ConceptStorePort` 窄契约）：
 *     它是**透传给 content 属主的概念抽取角色工厂**的，真正的调用点在 content 侧
 *     （`src/agents/concept-extractor-role.ts:88`，经其 `ConceptSink` 窄契约）。
 *     方法该留在端口面上——透传方拿不到它，那条链就断了；但它不是 automation 的自用面。
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
 * 故本端口上**两个方法都是必选**、不带 `?`（保留 `?` 等于保留一张假的安全网）。
 *
 * **签名照抄属主存储的真实签名**（见 `ConceptStore` 的同名方法），不另造一套更宽松的：
 * 属主实例结构上即满足本端口，组合根按原样注入；拆进程后换成 HTTP 客户端，调用点一行不用改。
 *
 * **失败语义（与本仓既有跨属主端口范式一致）**：方法返回**裸值**，失败**抛**
 * {@link file://./content-port-error.ts} 的 `ContentPortError`（按具名 `reason` 判，不用 `instanceof`）。
 *
 * **⚠️ 只写「不用 instanceof」是不够的，照那样写会得到一个永不触发的守卫。**
 * 本仓内部 HTTP 的错误编码只保 `code` + `message`，**`name` 与 `reason` 跨那一跳会全丢**，
 * 于是 `isContentPortError(线上错误)` 恒为 `false`——守卫本身跨不过去。
 * 所以传输适配层 **MUST** 先用 `contentPortReasonFromCode(err.code)` 还原、再重新抛出一个
 * `ContentPortError`；**还原不出返回 `null` 时 MUST NOT 套一个默认 reason**
 * （套默认会把「对面不支持这个方法」吞成「对面报错了」，下面那条回落分支就第二次变成死代码）。
 * 客户端侧的守卫要判的是**还原之后**的错误，不是线上原样收到的那个。
 * 读失败 MUST NOT 被翻译成「池是空的 / 没有新概念」。现役的两处降级——调度器「装载失败 → 回退空池」、
 * 抽取角色「写失败只记日志」——本身是合理的（不能让概念池拖垮浏览闭环），但拆进程后它们 MUST 变成
 * 调用方**看着具名原因明写**的决定，而不是 `catch` 顺手吃掉的副产物。
 *
 * 零 import 副作用、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */
import type { ConceptPool } from './concept-pool.js';

/**
 * 一条新概念及其来源笔记标题（形状照抄属主存储的真实返回，不另造更宽松的一套）。
 * `sourceNote` 缺失落 `null`，**不编造**——空字符串会让下游把「不知道从哪来的」写成「来自无标题笔记」。
 */
export interface ConceptWithSource {
  keyword: string;
  sourceNote: string | null;
}

export interface ConceptPoolPort {
  /**
   * 新增一个候选概念（已存在则不动，保留原状态）。
   *
   * 返回**是否真的插入了新行**：撞唯一键 → `false`（该词早就在池里），真插入 → `true`。
   * 实现方 MUST NOT 因为「请求发出去了」就回 `true` —— 那正是红线点名的静默假成功：
   * 抽取角色靠这个值判「这个词是不是我新发现的」，填错会让它把老词当新词一路报上去。
   */
  addCandidate(keyword: string, sourceNote?: string): Promise<boolean>;

  /** 装载整池快照（已搜过 / 已知 → known，未搜 → candidates）。 */
  loadPool(): Promise<ConceptPool>;

  /** 标记某概念已搜索（不存在则以 searched 插入）。属主侧是 upsert，无回执可言，故返回 void。 */
  markSearched(keyword: string): Promise<void>;

  /** 自某时刻起新发现的概念**数量**（发帖调度器的概念积累扳机按它判阈值）。 */
  countNewSince(sinceMs: number): Promise<number>;

  /**
   * 自某时刻起新发现的概念关键词。
   * **这是 `getNewConceptsWithSourceSince` 的回落分支**，只在后者抛出 `unsupported_method` 时调用。
   */
  getNewConceptsSince(sinceMs: number, limit?: number): Promise<string[]>;

  /** 自某时刻起新发现的概念关键词 + 各自来源笔记标题（发帖创作的首选取法）。 */
  getNewConceptsWithSourceSince(sinceMs: number, limit?: number): Promise<ConceptWithSource[]>;
}
