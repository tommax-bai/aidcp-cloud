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
