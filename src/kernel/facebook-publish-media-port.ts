/**
 * Facebook 发帖素材池的**跨属主端口面**（kernel，automation → content）。
 *
 * 属主是 content：存储实现 `src/publish-agent/facebook-publish-media-store.ts`，
 * 两张表 `account_facebook_publish_image_set` / `account_facebook_publish_image`
 * 在 `boundaries/table-ownership.json` 里都归 content 且**无任何写豁免**。
 * 单体里 automation 直接持着那个存储对象（经组装根装的一个三方法窄口）调它；
 * 拆进程后 automation 库里没有这两张表，这几条调用只能经本端口过去。
 * 对应欠账台账条目：`content-facebook-publish-media-authority`（consumer = automation and api）。
 *
 * **三个方法就是 automation 的全部消费面**，逐条对得上真实用法（没有消费者的方法一个都不开）：
 *   - `releaseReservation` ← `src/publish-agent/publish-dispatcher.ts:549`
 *     （提交前失败 / 被抢占分支：把这一组素材放回可用池）
 *     ＋ `src/server.ts:6146`（**segCAutomation 内的一处直调**，审批驳回时释放保留；
 *     它**不走**下发器那个窄口，接线时最容易漏的就是这一处）
 *   - `markUsed`           ← `src/publish-agent/publish-dispatcher.ts:545`（`published_confirmed` 分支）
 *   - `quarantine`         ← `src/publish-agent/publish-dispatcher.ts:547`（`submitted_unconfirmed` 分支）
 *
 * 下发器那个窄口本身在 `src/publish-agent/publish-dispatcher.ts:134-138`，签名与本端口**逐字相同**——
 * 本端口不是新造的一套，是把已经存在的那个窄口抬进 kernel。
 *
 * **属主另外六个方法一个都不在这里，因为它们的消费方不是 automation**：
 *   - `listForAccount` / `uploadFiles` / `reorder` / `updateSet` ← **api**（面板层
 *     `src/panel/panel-server.ts:1365` / `:1382` / `:1398` / `:1426` / `:1435`，
 *     经 `src/panel/types.ts:304-313` 的注入端口，已有自己的一条路径）；
 *   - `availableCount` ← **api**。⚠️ 这一条最容易判错，写清楚免得后来人「顺手补上」：
 *     它的**装配点**在组装根的 automation 段（`src/server.ts:7316`），
 *     但消费方文件 `src/orchestrator/content-scheduler.ts:127` / `:456` 在归属表里是 **api**，
 *     拆完之后它跟着 api 进程走。判「谁是消费方」的依据是**消费方文件的归属**——
 *     既有端口面全按这个口径（概念池数的是 `role-dispatcher.ts` 与 `publish-scheduler.ts`，
 *     两者归属都是 automation），**不是**它在组装根的哪一段被 new 出来。
 *     放进来等于凭空多开一条 automation 侧没人调的路由。
 *   - `reserveNext` ← content 自己（`src/publish-agent/roles/facebook-media-selector.ts:47`）；
 *   - `deleteSet` / `close` ← `src/` 内**零调用点**（面板那个「删除」按钮映到
 *     `updateSet(accountId, setId, { status: 'deleted' })`，见 `src/server.ts:8828-8829`）。
 *
 * **签名照抄属主存储的真实签名**（`facebook-publish-media-store.ts:437` / `:447` / `:457`）：
 * 属主实例结构上即满足本端口，组装根按原样注入；拆进程后换成 HTTP 客户端，调用点一行不用改。
 *
 * **三个 `boolean` 回执的语义是「那一行真的被改了吗」，MUST NOT 退化成「请求发出去了」。**
 * 属主侧三条全是带状态守卫的条件 UPDATE，回 `rowCount > 0`：
 *   - `releaseReservation` 只认 `reserved` 态，且传了 `reservationId` 就必须对得上；
 *   - `markUsed` 只认 `reserved` / `available` 两态；
 *   - `quarantine` 只放过尚未 `deleted` 的。
 * 所以 `false` 是一个**真实的领域答案**（这组素材已经不在调用方以为的状态上了），不是传输失败。
 * 实现方 MUST NOT 因为对面回了 200 就填 `true`——那正是红线点名的静默假成功。
 * 反过来，读不到 / 连不上 MUST 抛，MUST NOT 落成 `false`：`false` 会被读成
 * 「这组素材早被别人动过了」，而真相是「这次记账压根没发生」，素材会永久卡在 `reserved` 上没人回收。
 *
 * **失败语义（与本仓既有跨属主端口范式一致）**：方法返回**裸值**，失败**抛**
 * {@link file://./content-port-error.ts} 的 `ContentPortError`（按具名 `reason` 判，不用 `instanceof`）。
 *
 * ⚠️ **属主自己那族具名原因在这条边上不可判定，这是有意的。**
 * 属主抛的是 `FacebookPublishMediaError`（name / reason / code 见
 * {@link file://./facebook-publish-media-types.ts}），api 侧面板层靠它把 `object_store_unavailable`
 * 映成 503、`status_locked` 映成 409。但 **automation → content 方向的失败信号统一是
 * `ContentPortError`**，MUST NOT 在这条边上再立第二个 name。属主的原码与原文由传输层
 * 原样带进 `ContentPortError.detail`（`detail` **MUST NOT 参与任何判定**，只供日志与告警定位）。
 * 这不损失任何现有能力：今天 automation 侧两个调用点**都不按 reason 分支**——
 * 下发器只 `logger.warn`（`publish-dispatcher.ts:553-559`）、组装根那处直接吞掉。
 * 将来真要按 `status_locked` 之类分支，那是一次**端口变更**（在这里加具名回执或具名原因），
 * MUST NOT 靠去 parse `detail` 文案。
 *
 * 零 import、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */

export interface FacebookPublishMediaPort {
  /**
   * 把一组保留中的素材放回可用池（`reserved` → `available`）。
   *
   * `reservationId` 省略即不校验持有者；传了就必须与库里的持有者一致，否则不改任何行、回 `false`。
   * 回 `false` 的两种现实情形——这组素材已经不是 `reserved` 了，或者它属于另一次保留——
   * 都是**真实答案**，MUST NOT 与「没问到对面」混为一谈（后者 MUST 抛）。
   */
  releaseReservation(setId: number, reservationId?: string): Promise<boolean>;

  /**
   * 确认这组素材已随某条发布记录真正发出（`reserved` / `available` → `used`），并记下发布记录号。
   *
   * 回 `false` ＝ 这组素材当时不在那两个状态上（例如已被隔离或已删），属主没有改任何行。
   * 调用方 MUST 把它当「记账没落上」处理并留痕，MUST NOT 当成功。
   */
  markUsed(setId: number, publishLogId: number): Promise<boolean>;

  /**
   * 把一组素材隔离（→ `quarantine`）并记下原因，用于「已提交但拿不到确认」这种结局：
   * 既不能当成功用掉、也不能放回可用池给下一条稿再发一次。
   *
   * `reason` 是**留痕文案**，MUST NOT 被任何判定读取；属主侧会按自己的列宽截断。
   * 回 `false` ＝ 这组素材已经是 `deleted`，属主没有改任何行。
   */
  quarantine(setId: number, reason: string): Promise<boolean>;
}
