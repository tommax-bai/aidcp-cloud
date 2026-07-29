/**
 * 模型 token 用量**记账写侧**的跨属主端口面（kernel，automation → content）。
 *
 * 属主是 content：存储实现 `src/metrics/token-usage-store.ts`，表 `llm_token_usage`
 * （`boundaries/table-ownership.json` 归 content，无写豁免）。属主文件头明写自己是这张表的
 * **唯一写入口**，其它服务 MUST 经它暴露的用量上报接口写、MUST NOT 直写。本端口就是那个接口
 * 跨进程之后的样子。对应欠账台账条目：`content-token-usage-authority`（consumer = automation and api）。
 *
 * **一个方法就是 automation 的全部消费面**（没有消费者的方法一个都不开）。真实调用点只有一处：
 *   - `src/server.ts:6507`，`segCAutomation` 段内那个上报闭包 `recordVisionCall` 里的
 *     `tokenUsageStore.add(info)`。它挂在文字卡 OCR 那两个视觉客户端的调用完成回调上
 *     （`src/server.ts:6516` / `:6529`），即 automation 进程自己发起的模型调用要记的账。
 *     这正是台账里那条 `segCAutomation:identifier-use:tokenUsageStore` 证据。
 *
 * **消费方文件是组装根、不是某个 automation 属主文件——这与既有几个端口面不同，写清楚免得被当成判错。**
 * 概念池 / 精选库那两条的消费方是真正的 automation 属主文件（角色调度器、发帖调度器、评论调度器）；
 * 这一条的消费方是组装根 `segCAutomation` 段里的一个闭包，它拆完之后落进 automation 进程的 `main()`。
 * 判据仍成立：**automation 进程自己会发起模型调用，就得自己记账**，而账落在 content 的表上。
 *
 * **另外三个写侧方法不在这里**，因为它们的消费方不是 automation：
 *   - `upsertBillingPrices` / `billingPriceTargets` ← **api**（面板手动触发的账单价格刷新，
 *     `src/panel/panel-server.ts:1582` / `:1586` → `src/metrics/billing-price-refresh.ts`）；
 *   - `purgeOlderThan`（保留期清理）← 属主自驱的定时器，跨界零调用点。
 * 读侧 `usage()` 同样是 api（面板 `GET /api/llm-usage`，经 `src/panel/types.ts:424` 那个注入端口，
 * 载荷类型已在 {@link file://./llm-usage-types.ts}）。
 *
 * ═══ 为什么本端口**不是**照抄属主签名（唯一一处刻意的偏离，理由写全） ═══
 *
 * 属主的记账入口是 `add(info): void`：**同步、无返回、纯内存**，按
 * `10 分钟桶 + 账号 + 角色 + 厂商 + 模型` 在内存里合并，另有一个定时器把合并结果批量落库。
 * 这个签名**跨不过进程边界**，照抄只会得到一个必然撒谎的方法：
 *   ① `void` + 同步 ⇒ 客户端只能发完就走。这一跳上的任何失败都无处可报，
 *      恰是红线点名的静默假成功——账没记上，调用方却什么都不知道。
 *   ② 一次模型调用一次 HTTP ⇒ 属主文件头列的三条不变量里的「批量」当场失效，
 *      且把一条低频旁路挂到了每一次模型调用的热路径上（属主自己写着 MUST NOT 拖垮模型调用）。
 *
 * 所以本端口的形状是**批量提交已经合并好的增量行**——也就是属主那个定时器今天真正落库的东西。
 * 合并与打桶留在调用方（它本来就在调用方的内存里），跨界的只有结果。
 *
 * **属主今天没有这个方法。** 这不是疏漏，是与 {@link file://./curated-selection-port.ts} 的
 * `selectSamplesForSearchTerms` 完全同形的一件事：content 接线时必须二选一——
 * 给属主存储补上 `recordUsage`（把批量落库那段从私有定时器里提出来），或交一个满足本端口的适配对象。
 * 两者都没做，服务端的在场探针会把缺失当场译成具名的 `unsupported_method`，
 * **不会**静默变成「记上了」。
 *
 * ═══ 三条 MUST，都是「照直觉写就会错」的地方 ═══
 *
 * ① **桶起点由调用方戳，MUST NOT 由属主用收到请求的时刻重算。**
 *    今天桶是在 `add()` 那一刻按当时的钟算的。批量提交必然晚于发生时刻（要等合并窗口，
 *    还可能因重试再晚），属主重算等于把一批用量整体挪进错误的时间桶——曲线会平移，
 *    而且没有任何东西会报错。
 *
 * ② **重试会重复计数，所以传输失败 MUST NOT 重试。**
 *    属主侧是 `ON CONFLICT ... 累加`（可交换计数器，不是幂等写）。同一批提交两次 ＝ 数字翻倍。
 *    超时是典型的**结果未知**：对面可能已经加上了。用量是**可丢**的观测数据（属主文件头第三条
 *    不变量原话），所以这里的正确处置是**丢弃并计数留痕**，MUST NOT 重投、
 *    更 MUST NOT 把「不知道成没成」记成成功。
 *
 * ③ **回执是「真的落库了几行」，不是「请求发出去了」。**
 *    属主侧逐行写、逐行容错，天然可能只落一部分。`applied` 小于提交行数即有增量被丢，
 *    调用方 MUST 把差额计数留痕（等价于属主今天那个丢弃计数器），MUST NOT 当成全部成功。
 *
 * ═══ 成本不在这条边上，而且**不许**在这一层出现 ═══
 *
 * 本端口只搬 **token 计数**。成本不是记账时算的，也不存在用量行里：它是**读时**用
 * 账单反算出来的单价快照 JOIN 出来的（属主侧读聚合），单价由
 * `src/metrics/billing-price-refresh.ts` 从厂商账单明细「金额 ÷ token 数」反算而来。
 * 已上线规格 `llm-token-usage-stats` 的 `Token Usage Cost Estimates` 明文要求成本
 * MUST 由厂商账单反算、MUST NOT 依赖任何硬编码的公开模型价目表。
 * 因此本端口 **MUST NOT** 新增任何单价 / 金额 / 币种字段，接线方也 MUST NOT 在传输层
 * 就地折算成本——那等于在这一层偷偷立一张价目表。
 *
 * **失败语义（与本仓既有跨属主端口范式一致）**：方法返回**裸值**，失败**抛**
 * {@link file://./content-port-error.ts} 的 `ContentPortError`（按具名 `reason` 判，不用 `instanceof`）。
 *
 * 零 import、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */

/**
 * 用量桶宽（毫秒）。桶起点 MUST 是它的整数倍——两侧共用这一个常量，
 * 各拼各的会让同一次调用按不同粒度落成两行，而表的主键**不会**因此报错，只会悄悄多出一行。
 */
export const LLM_USAGE_BUCKET_MS = 600_000;

/** 把某一时刻对齐到它所属的桶起点。两侧共用，防止对齐口径各写一遍。 */
export function llmUsageBucketStart(atMs: number): number {
  return Math.floor(atMs / LLM_USAGE_BUCKET_MS) * LLM_USAGE_BUCKET_MS;
}

/**
 * 一条已经合并好的用量增量。
 *
 * 前五个字段共同构成**合并键**（与属主表的主键逐字相同）：同一个键的多次调用在调用方内存里
 * 先加成一行，跨界之后由属主继续累加。
 *
 * 三个维度字段都是**必填非空**，不接受空串：跨进程之后空串是个看起来完全合法的维度取值，
 * 会落成一行谁都归属不了的账，而不是被谁挡下来。缺省值（未打标的角色、认不出的厂商）
 * MUST 由调用方在合并**之前**显式填成自己的占位取值，MUST NOT 指望属主兜底。
 */
export interface LlmUsageIncrement {
  /** 桶起点（epoch ms），MUST 是 {@link LLM_USAGE_BUCKET_MS} 的整数倍，且**由调用方在调用发生时戳**。 */
  bucketStartMs: number;
  /** 归属账号。**没有账号的调用 MUST 在调用方就被丢掉**（属主今天也是这么做的），不要送到这里来。 */
  accountId: string;
  /** 角色标识；未打标的调用由调用方显式填占位值。 */
  role: string;
  /** 厂商标识；认不出的由调用方显式填占位值。 */
  provider: string;
  /** 模型标识。 */
  model: string;
  /** 本键下累计的输入 token 数（非负整数）。 */
  promptTokens: number;
  /** 本键下累计的输出 token 数（非负整数）。 */
  completionTokens: number;
  /**
   * 本键下累计的总 token 数（非负整数）。
   * **MUST 是厂商真实回报的合计**，MUST NOT 由输入 + 输出凑出来：
   * 两者对不上时那个差额本身就是信号（缓存命中、思考 token…），凑数会把它抹平。
   */
  totalTokens: number;
  /** 本键下累计的调用次数（正整数）。 */
  calls: number;
  /** 其中成功的次数（非负整数，且 MUST NOT 大于 `calls`）。 */
  okCalls: number;
}

export interface LlmUsageRecordingPort {
  /**
   * 批量提交已合并的用量增量，返回**真正落库的行数**。
   *
   * 空数组是合法输入、返回 0（调用方的合并窗口里什么都没发生），MUST NOT 因此报错。
   * 返回值小于提交行数 ＝ 属主丢了几行，调用方 MUST 留痕，见文件头第 ③ 条。
   * 失败 MUST 抛，MUST NOT 回 0——0 与「这一批一行都没落上」长得一样，
   * 但前者是「对面明确说它一行都没写」，后者是「压根没问到对面」。
   */
  recordUsage(increments: readonly LlmUsageIncrement[]): Promise<number>;
}
