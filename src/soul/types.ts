/**
 * Agent Soul 配置的类型定义。
 *
 * Soul 给 agent 注入"人设、品味、浏览行为"：
 * - identity：身份/语气；
 * - interests：兴趣（主/次 + 搜索种子词）；
 * - engagement_rules：互动规则（硬质量门槛 + 点赞/跳过/评论倾向）；
 * - browse_patterns：浏览状态机（browse↔search）+ 会话上限。
 *
 * 该结构是 soul.yaml 的强类型投影；loader 负责把 YAML 校验装载成 Soul。
 */

export interface SoulIdentity {
  name: string;
  role: string;
  background: string;
  tone: string;
}

export interface SoulInterests {
  primary: string[];
  secondary: string[];
  seed_keywords: string[];
}

export interface QualityThreshold {
  min_likes: number;
  min_collects: number;
}

export interface EngagementRules {
  quality_threshold: QualityThreshold;
  like: string[];
  skip: string[];
  comment_trigger: string[];
}

/** 浏览状态机中，search 状态的关键词来源 */
export type SearchSource =
  | 'extract_from_liked'
  | 'random_from_interests'
  | 'new_concept';

export interface StateTransition {
  /** 触发条件标识（如 "liked_count >= 3" / "browsed_3_results"） */
  trigger: string;
  /** 迁移目标状态名 */
  to: string;
  /** 若迁移到 search，关键词来源策略 */
  search_source?: SearchSource;
}

export interface BrowseStateDef {
  /** 该状态的人类可读动作描述 */
  action: string;
  /** search 状态：单次最多浏览的搜索结果数 */
  max_results_to_browse?: number;
  transitions: StateTransition[];
}

export interface SessionLimits {
  max_duration_min: number;
  max_likes: number;
  max_searches: number;
  /** 两次动作之间的随机冷却区间 [min, max] 秒 */
  cooldown_between_actions_sec: [number, number];
}

export interface BrowsePatterns {
  mode: string;
  states: Record<string, BrowseStateDef>;
  session: SessionLimits;
}

export interface Soul {
  identity: SoulIdentity;
  interests: SoulInterests;
  engagement_rules: EngagementRules;
  browse_patterns: BrowsePatterns;
}
