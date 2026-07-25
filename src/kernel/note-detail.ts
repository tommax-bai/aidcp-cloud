/**
 * 详情页笔记数据的**纯数据模型**（原定义在 src/agents/content-curator-role.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供 content 侧精选评估角色跨边界共导。
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 * 承载类 ContentCuratorRole + 事件订阅逻辑留 content-curator-role.ts（automation）。
 */
export interface NoteData {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  /** 详情页作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注/互关→true。
   *  由 note.detail 透传，AuthorEvaluator 据此在评估进主页前短路已关注作者。缺省→原流程。 */
  authorFollowed?: boolean;
  /** 帖子下他人评论正文样本（change platform-vocabulary-and-thresholds 2.1）：撰写器据此贴合评论区语境。
   *  Facebook 走 note.detail 透传；小红书由 dispatcher 从 scroll_comments 回执候选归集。缺省→撰写只看正文。 */
  comments?: string[];
}

/**
 * 详情页图片引用（change cloud-coupling-phase5）。
 *
 * 与边云协议 `NoteImagePayload`（`src/comm/protocol.ts`）**逐字同形**，但**刻意不 import 它**：
 * 协议文件归 automation，kernel MUST NOT 反向依赖业务层。两侧在赋值点相遇——automation 把
 * 协议载荷装进 `NoteDetailData` 时，形状不兼容会当场被 typecheck 挡下（漂移守卫落在赋值缝、非静默）。
 */
export interface NoteDetailImage {
  index: number;
  url: string;
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * 边缘上报的详情页数据（change cloud-coupling-phase5 从 `src/event-bus/types.ts` 抬入）。
 *
 * 抬入理由不是「共导多」，而是**拆仓后 content 仓的 src 里根本没有 event-bus/types.ts**：
 * 概念抽取与笔记精选评估两个 content 角色以它为事件载荷类型，留在 automation 会让 content 仓
 * 直接编译不过——豁免管得住门禁，管不住模块解析。
 *
 * 与 `NoteData` 的分工：本类型是**边缘上报的原始详情载荷**，`NoteData` 是精选/策展侧的加工模型。
 * 两者字段高度重叠但来源不同，MUST NOT 合并成一个。
 */
export interface NoteDetailData {
  noteId: string;
  title: string;
  content: string;
  /** 缺省按 image_text 兼容老边端。 */
  mediaType?: 'image_text' | 'video';
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
  /** 发布相对时刻原始文本（change feed-hot-lead-group-comment）；云端解析算热度速率。缺则诚实置空。 */
  publishedAtText?: string;
  /** 详情页带 xsec_token 的链接（change interaction-feed-enrichment）；缺则诚实置空。 */
  url?: string;
  /** Original carousel images observed by edge; empty/missing means unavailable. */
  images?: NoteDetailImage[];
  /** Refresh-only image snapshot; not a new view and not a normal browse-detail decision event. */
  refreshOnly?: boolean;
  /**
   * 帖子下他人评论正文样本（change platform-vocabulary-and-thresholds 2.1）：边缘就地读 / 详情深读采到多少报多少，
   * 采不到即缺省——MUST NOT 伪造。Facebook 图片帖常无正文，这些评论是撰写的主要文字依据。
   * 协议早有此字段（protocol.ts NoteDetailPayload.comments）、边缘 FB 三条路径均已上报，此前只因本事件类型
   * 未声明而在云端被静默丢弃。小红书的 note.detail 不带评论，其现场评论走 action.completed{scroll_comments}.candidates。
   */
  comments?: string[];
}
