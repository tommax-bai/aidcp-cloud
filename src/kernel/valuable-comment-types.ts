/**
 * 优质评论语料的**纯类型契约 + 无 LLM 主题键派生**（kernel 段）。
 *
 * 只含 `ValuableCommentInput` 数据模型与 `topicKeysFromTitle` 纯字符串函数——无 SQL、无 pg 连接、
 * 无存储类、无进程内活状态（函数体内的局部 Set 不是模块级单例）。存储实现（VALUABLE_COMMENT_SCHEMA_SQL、
 * ValuableCommentStore 类、读写方法）留在 src/cache/valuable-comment-store.ts（automation）。
 * 本文件供 content 侧精选评估角色（curated-*-evaluator / valuable-comment-archivist）type-only /
 * 纯函数共导，绝不让消费方拿到存储实现。
 */

/** 从笔记标题派生主题键（无 LLM）：小写拉丁词（≥2 长）+ CJK 字符二元组；去重、截断。 */
export function topicKeysFromTitle(title: string | undefined, max = 24): string[] {
  if (!title) return [];
  const keys = new Set<string>();
  // 拉丁/数字词
  const latin = title.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  for (const w of latin) keys.add(w);
  // CJK 字符二元组
  const cjk = title.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) keys.add(cjk[i] + cjk[i + 1]);
  return Array.from(keys).slice(0, max);
}

export interface ValuableCommentInput {
  /** 去重键（用评论锚点 comment-<id>）。 */
  dedupKey: string;
  text: string;
  author?: string;
  sourceNoteId?: string;
  sourceNoteTitle?: string;
  topics: string[];
  reason?: string;
  /** 该评论的点赞数（change curated-inspiration-corpus Phase 2b）；valuable_comments 表不存此列、仅透传给精选语料。 */
  likeCount?: number;
}
