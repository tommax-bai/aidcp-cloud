/**
 * Publish Agent 类型定义。
 *
 * Publish Agent 基于浏览积累的概念（concepts）与点赞内容（liked notes），
 * 由 Qwen 生成一篇"有人味"的小红书技术帖，经去 AI 味后处理后，通过边缘发布。
 *
 * 本文件是发布链路的类型契约：触发条件 / 生成输入输出 / 后处理结果 / 发布记录。
 */

import type { Soul } from '../soul/types.js';

/** 一个已积累的技术概念（concepts 表的投影）。 */
export interface Concept {
  /** 概念关键词 */
  keyword: string;
  /** 来源笔记标题（可空） */
  sourceNote?: string;
  /** 发现时间（毫秒时间戳，可空） */
  discoveredAt?: number;
}

/** 一条点赞过的笔记摘要（供生成内容时引用真实细节）。 */
export interface LikedNote {
  /** 点赞记录 id（用于回填 source_liked_ids） */
  id: number;
  /** 笔记标题 */
  title: string;
  /** 正文摘要 */
  summary: string;
  /** 作者（可空） */
  author?: string;
}

/** 混合触发条件配置（两个内容条件 + 一个时间硬下限 + 一个软上限）。 */
export interface PublishTriggerConfig {
  /** 距上次发布的最小小时数（硬下限：未到不发） */
  minTimeSinceLastPublishHours: number;
  /** 新积累概念的最小数量 */
  minNewConcepts: number;
  /** 上次发布后点赞的最小数量 */
  minLikedSinceLastPublish: number;
  /** 软上限：超过该小时数未发布则放宽内容量要求（concepts >= 1 即可） */
  maxSilenceHours: number;
}

/** 默认触发配置（与设计约束一致）。 */
export const DEFAULT_TRIGGER_CONFIG: PublishTriggerConfig = {
  minTimeSinceLastPublishHours: 20,
  minNewConcepts: 3,
  minLikedSinceLastPublish: 15,
  maxSilenceHours: 48,
};

/** 触发判定所需的当前度量。 */
export interface TriggerMetrics {
  /** 距上次发布的小时数；从未发布过传 Infinity */
  hoursSinceLastPublish: number;
  /** 上次发布后新积累的概念数 */
  newConceptCount: number;
  /** 上次发布后的点赞数 */
  likedSinceLastPublish: number;
}

/** 触发判定结果。 */
export interface TriggerDecision {
  /** 是否应当发布 */
  shouldPublish: boolean;
  /** 是否走了软上限放宽路径 */
  relaxed: boolean;
  /** 判定说明（调试/观测用） */
  reason: string;
}

/** 内容生成输入。 */
export interface GenerateInput {
  /** 最近积累的新概念 */
  concepts: Concept[];
  /** 最近点赞的内容摘要 */
  likedContents: LikedNote[];
  /** 人设信息 */
  soul: Soul;
  /** 最近 3 篇已发布内容（避免重复话题） */
  recentPosts: string[];
}

/** 内容生成输出。 */
export interface GenerateOutput {
  /** 小红书标题（20 字内，可带 emoji） */
  title: string;
  /** 正文（200-500 字） */
  content: string;
  /** 话题标签（3-5 个） */
  tags: string[];
}

/** 去 AI 味后处理结果。 */
export interface PostProcessResult {
  /** 处理后的正文（可能被重写） */
  content: string;
  /** 0-1，AI 味浓度评分（命中禁用词越多越高） */
  aiScore: number;
  /** 是否触发了重写 */
  rewritten: boolean;
  /** 命中的禁用词/句式 */
  flaggedPhrases: string[];
}

/** 发布记录状态。 */
export type PublishStatus = 'draft' | 'published' | 'failed' | 'needs_review';

/** 一条发布记录（publish_log 表的投影）。 */
export interface PublishRecord {
  id?: number;
  title: string | null;
  content: string;
  /** 引用的概念关键词 */
  sourceConcepts: string[];
  /** 引用的点赞内容 id */
  sourceLikedIds: number[];
  status: PublishStatus;
  /** 发布成功后回填的平台帖子 id */
  platformPostId?: string | null;
}