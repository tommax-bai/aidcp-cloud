/**
 * 精选库**写侧**的跨属主端口面（kernel，automation → content）。
 *
 * 与 {@link file://./curated-selection-port.ts} 是同一张表的两张脸，**刻意分成两个文件**：
 * 召回那张的消费方是发帖调度器与评论调度器，本张的消费方是两个精选准入评估角色 + 组装根，
 * 失败后果也不同（召回失败＝没素材可用，写失败＝这一条观测永久丢了）。合成一个端口会让
 * 「只需要读」的调用方结构上也拿到写能力，而那正是本项目按最小面开端口的理由。
 *
 * 精选库存储是 content 属主（表 `curated_content`）。单体里 automation 直接持着那个存储对象调方法；
 * 拆进程后 automation 库里没有这张表，这五条调用只能经本端口过去。
 *
 * **五个方法就是全部消费面**，逐条对得上真实调用点（没有消费者的方法一个都不开）：
 *   - `upsertObservation`     ← `src/agents/curated-note-evaluator.ts:362`（模型评估通过 → 落精选素材）
 *   - `refreshReferenceImages` ← 同文件 `:253`（详情页重新观测到图集 → 洗掉旧注解与旧转写）
 *   - `getTextCardContext`    ← 同文件 `:293`（准入期转写的读穿缓存；**本张脸上唯一的读**）
 *   - `archiveComment`        ← `src/agents/curated-comment-evaluator.ts:159`（优质评论落语料）
 *   - `markBotAction`         ← 组装根 segC（自有点赞 / 收藏并入精选语料）
 *
 * 那两个角色类**已随 task 0.7 改判 automation 属主**，所以它们不是 content 侧代码在写 content 表，
 * 而是货真价实的跨属主写——这正是台账条目 `content-curated-write-authority` 指的东西。
 *
 * **`getTextCardContext` 为什么在写侧而不在召回侧**：它读的是「这条源帖此刻的图集与转写」，
 * 只被准入评估在**写之前**用作读穿缓存，与召回那两条（按账号挑素材、带排序与时间窗）
 * 既不同调用方也不同语义。放到召回那张脸上会让只读召回的调用方看见一个它永远不该问的问题。
 *
 * **签名照抄属主存储的真实签名**，不另造一套更宽松的：属主实例结构上即满足本端口，
 * 组装根按原样注入；拆进程后换成 HTTP 客户端，五个调用点一行不用改。
 *
 * **失败语义（与本仓既有跨属主端口范式一致）**：方法返回**裸值**，失败**抛**
 * {@link file://./content-port-error.ts} 的 `ContentPortError`（按具名 `reason` 判，不用 `instanceof`）。
 *
 * **⚠️ 只写「不用 instanceof」是不够的，照那样写会得到一个永不触发的守卫。**
 * 本仓内部 HTTP 的错误编码只保 `code` + `message`，**`name` 与 `reason` 跨那一跳会全丢**。
 * 传输适配层 MUST 先按码还原、再重新抛出；**还原不出返回 `null` 时 MUST NOT 套一个默认 reason**。
 * 这一层今天只有一份实现（`content-authority-wire.ts`），新端口一律取用它，MUST NOT 再复制一份。
 *
 * **三条只对写侧成立、召回那张脸上没有的约束：**
 *
 * ① **返回 `void` 的三个方法，跨线时 MUST 由传输层回一个显式回执。** `undefined` 编码后是空响应体，
 *    与「这条路由压根没跑」逐字节一样——写没做成会读起来像做成了。端口签名保持 `void`
 *    （照抄属主），回执是传输层的事，调用方拿到的仍是 `void`。
 *
 * ② **写失败 MUST NOT 被译成「这条本来就不该写」。** 属主侧几处真实的 no-op（正文为空不落库、
 *    点赞时目标行不存在则不自动建行）在单体里与「写失败」区分得开，因为后者会抛；
 *    跨进程后如果哪一层把抛出吃成静默返回，这两件事就永久混成一件，
 *    而精选语料是**只会少不会多**的——少一条谁都不会发现。
 *
 * ③ **`refreshReferenceImages` 的返回值是真实受影响行数，MUST NOT 由传输层编造。** 调用方按它
 *    判「这条源帖在库里存在吗」；回一个乐观的 1 会让后续转写往一条不存在的行上写。
 *
 * 零 import 副作用、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */
import type {
  CuratedActionContent,
  CuratedObservation,
  CuratedReferenceImageInput,
  CuratedSourceContentType,
  CuratedTextCardContext,
} from './curated-content-types.js';

/** 优质评论归档入参（形状照抄属主真实签名的行内对象，不另造更宽松的一套）。 */
export interface CuratedCommentArchiveInput {
  sourceId: string;
  text: string;
  author?: string;
  topics: string[];
  sourceNoteTitle?: string;
  reason?: string;
  /** 缺失落 `null`，**区别于真实的 0**——别在这一步把「没读到点赞数」填成「零个赞」。 */
  likeCount?: number | null;
}

export interface CuratedWritePort {
  /**
   * 观测落库 / 刷新（账号维度去重）。
   *
   * 属主侧对**正文为空**是一次有意的 no-op（不落空壳行），这不是失败。跨进程后
   * 「正文为空所以没写」与「写请求没到达」MUST 仍然分得开：前者正常返回，后者抛。
   */
  upsertObservation(obs: CuratedObservation): Promise<void>;

  /**
   * 用重新观测到的图集覆盖既有行，并**同时洗掉旧的视觉分析与旧的文字卡转写**
   * （图换了，基于旧图的派生结论一律作废）。
   *
   * 返回**真实受影响行数**：0 意味着库里没有这条源帖，是调用方要据以分支的领域答案。
   * MUST NOT 因为「请求发出去了」就回 1。
   */
  refreshReferenceImages(
    accountId: string,
    sourceId: string,
    contentType: CuratedSourceContentType,
    input: CuratedReferenceImageInput[] | undefined,
  ): Promise<number>;

  /**
   * 准入期转写的读穿缓存：取这条源帖当前的图集与已有转写。
   * 不存在返回 `null`——**`null` 是「库里没有这条」，不是「读失败」**，后者抛。
   */
  getTextCardContext(
    accountId: string,
    sourceId: string,
    contentType: CuratedSourceContentType,
  ): Promise<CuratedTextCardContext | null>;

  /** 优质评论落语料（同键重复即忽略，评论一经确认点赞即归档、不刷新）。 */
  archiveComment(accountId: string, input: CuratedCommentArchiveInput): Promise<void>;

  /**
   * 自有动作并入精选语料。两种动作强弱不同，**这个差别属于属主的领域规则、不在本端口上表达**：
   * 点赞是弱信号（只标既有行，行不存在则不建）；收藏是强信号（正文非空时自动建 / 纳入）。
   * 调用方照原样传，别在调用侧复制一份这个规则。
   */
  markBotAction(
    accountId: string,
    sourceId: string,
    action: 'like' | 'collect',
    content?: CuratedActionContent,
  ): Promise<void>;
}
