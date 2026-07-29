/**
 * 精选库**召回**的跨属主端口面（kernel，automation → content）。
 *
 * 精选库存储是 content 属主（`src/cache/curated-content-store.ts`，表 `curated_content`）。
 * 它对外二十余个方法（准入、观测刷新、面板治理、保留期修剪…）全都不属于 automation；
 * automation 真正跨界用到的**只有召回这一件事**，且只有两个调用方：
 *
 *   ① 发帖创作素材 —— `src/publish-agent/publish-scheduler.ts:264-270`（经其 `SchedulerCuratedStore` 窄契约），
 *      取**全字段**视图，一次两问：`source_post`（limit = selectTopK，默认 8）当正向素材，
 *      `comment`（limit = 3）当读者角度线索；两问都可能带「只要这一刻之后被观测刷新过的行」时间窗。
 *      单体接线在 `src/server.ts:7224`。
 *   ② 评论搜索词样本 —— `src/comment-agent/comment-scheduler.ts:1603`（经其 `selectCurated` 注入），
 *      取 `source_post`、limit 8、**不带时间窗**，而且只要三个字段。
 *      单体接线在 `src/server.ts:7021-7026`，那里挂着一个 `.then(rows => rows.map(...))` 的窄投影。
 *
 * **两个调用方要的形状不一样，所以这里是两个方法、不是一个。**
 * 把②合并成「①之后调用方自己 map」跨进程会很贵也很蠢：全字段视图里挂着参照图集、视觉分析、
 * 文字卡转写——都是大块 JSON——搬过进程边界只为了留下标题、话题、收藏数三个字段。
 * 投影本来就该发生在属主那一侧；它今天已经写在组合根里了，拆开时顺势归位即可。
 *
 * **一个必须当场处置的诚实问题**：`src/server.ts:7024` 今天写的是
 * `curatedContentStore ? … : Promise.resolve([])`，`comment-scheduler.ts:1603` 那侧还叠了一层
 * `.catch(() => [])`。同进程里这没问题——精选库没接线就是真没有素材。跨进程后这两处会把
 * **「连不上内容域」原样吃成「没有精选素材」**：搜索词生成拿零样本照跑、发帖创作以为没素材照发，
 * 全程零报错。
 *
 * **失败语义（与本仓既有跨属主端口范式一致）**：方法返回**裸值**，失败**抛**
 * {@link file://./content-port-error.ts} 的 `ContentPortError` —— 抛出本来就不是空数组，
 * 「对面回答了空」与「没问到对面」自然分得开；判定按具名 `reason`，不用 `instanceof`。
 *
 * **⚠️ 只写「不用 instanceof」是不够的，照那样写会得到一个永不触发的守卫。**
 * 本仓内部 HTTP 的错误编码只保 `code` + `message`，**`name` 与 `reason` 跨那一跳会全丢**，
 * 于是 `isContentPortError(线上错误)` 恒为 `false`——守卫本身跨不过去。
 * 传输适配层 **MUST** 先用 `contentPortReasonFromCode(err.code)` 还原、再重新抛出；
 * **还原不出返回 `null` 时 MUST NOT 套默认 reason**。守卫要判的是**还原之后**的错误。
 * 这与属主侧既有行为同向：精选表缺失时它本来就抛具名的 `CuratedContentUnavailableError`
 * （见 `curated-content-types.ts`），**绝不回落空结果**。要降级仍可以降，
 * 但必须是调用方看着具名原因**明写**的一个决定，那两处 `Promise.resolve([])` / `.catch(() => [])` 得改。
 *
 * 签名照抄属主存储的真实签名；拆进程后换 HTTP 客户端，调用点不改。
 *
 * **⚠️ 「属主实例结构上即满足本端口」这句对 `selectForCreation` 成立，对
 * `selectSamplesForSearchTerms` 不成立**（原文写成两条都成立，是错的，2026-07-29 实测更正）。
 * 属主存储**根本没有**这个方法——三字段窄投影今天写在组装根的一个 `.then(rows => rows.map(...))` 里。
 * 这不只是 automation 侧的事：服务端注册函数要求 **content 侧也交一个满足两条方法的对象**，
 * 否则它的在场探针会把缺失当场译成「不支持这个方法」。
 * content 接线时必须二选一：**给属主存储补上 `selectSamplesForSearchTerms`**（把投影归位属主，
 * 也正是本文件上面②要求的），或同样交一个适配对象。
 * 因此「不支持这个方法」这个具名原因的**现实触发路径有两条**，不止「对面旧版本没注册这条路由」：
 * 另一条就是服务端在场探针判 false。对回落分支是好消息——它比原注释描述的更容易真被走到。
 *
 * 零 import 副作用、零 SQL、零 HTTP、零模型调用、无进程内活状态，满足 §4.7 kernel 准入。
 */
import type { CuratedContentTypeFilter, CuratedSelectItem } from './curated-content-types.js';

/**
 * 召回时间窗（形状照抄属主存储真实签名里的 `opts`，不另造更宽松的一套）。
 * 缺省 → 不按更新时间过滤（既有行为）。
 */
export interface CuratedSelectionWindow {
  /** 只召回自此刻起被观测刷新过的行（epoch ms）。 */
  updatedSinceMs?: number;
}

/**
 * 搜索词生成样本 —— 属主侧完成的窄投影，跨进程只搬这三个字段。
 * 计数诚实置空：`collectCount` 缺失为 `null`（**区别于真实的 0**，别在投影这一步把它填成 0）。
 */
export interface CuratedTermSample {
  title: string;
  topics: string[];
  collectCount: number | null;
}

export interface CuratedSelectionPort {
  /**
   * 创作素材召回（发帖侧）：自有动作优先、再按收藏数与更新时间排序，按账号 + 内容类型过滤。
   * 返回全字段视图 `CuratedSelectItem`（含参照图 / 视觉分析 / 文字卡转写——发帖配图段真的要用）。
   */
  selectForCreation(
    accountId: string,
    contentType: CuratedContentTypeFilter,
    limit: number,
    window?: CuratedSelectionWindow,
  ): Promise<CuratedSelectItem[]>;

  /**
   * 搜索词样本召回（评论侧）：与上一条**同一份排序与过滤**，但由属主侧投影成三字段后再过边界。
   * 单独成方法的理由是形状与代价，不是洁癖——见文件头②。
   */
  selectSamplesForSearchTerms(
    accountId: string,
    contentType: CuratedContentTypeFilter,
    limit: number,
  ): Promise<CuratedTermSample[]>;
}
