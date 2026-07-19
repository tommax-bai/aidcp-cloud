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

export interface EngagementRules {
  like: string[];
  skip: string[];
  comment_trigger: string[];
}

/** 账号显式声明的确定性互动动作。只允许已有 note-scoped 写动作。 */
export type MandatoryInteractionAction = 'like' | 'comment';

/** 评论授权模式：review=逐条人审；auto_approve=人设站立授权，但仍须先发免审通知。 */
export type MandatoryCommentApproval = 'review' | 'auto_approve';

/**
 * 结构化强制互动规则（change facebook-mandatory-recruitment-interaction）。
 *
 * `when` 由详情粗筛 LLM 对真实全文做一次语义确认；命中后 actions 不再进入普通“要不要互动”判定。
 * comment 必须与 like 同配，保持既有“先发生互动再进评论支线”的事件合同。
 */
export interface MandatoryInteractionRule {
  id: string;
  when: string;
  actions: MandatoryInteractionAction[];
  comment_guidance?: string;
  comment_approval?: MandatoryCommentApproval;
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
  max_collects?: number;
  max_searches: number;
  /** 两次动作之间的随机冷却区间 [min, max] 秒 */
  cooldown_between_actions_sec: [number, number];
}

export interface BrowsePatterns {
  mode: string;
  states: Record<string, BrowseStateDef>;
  session: SessionLimits;
}

export interface BehaviorGuidelines {
  style: string;
  privacy: string;
  collection_principle: string;
  like_principle: string;
  /** 普通点赞软倾向；缺省等价 normal，绝不代表 mandatory like 授权。 */
  like_affinity?: LikeAffinity;
}

export type LikeAffinity = 'normal' | 'like_more' | 'like_most';

/** Facebook 账号对外公开文本的受控写作语言。 */
export type WritingLanguage = 'zh-CN' | 'en' | 'vi';

export interface Soul {
  /** 身份与语气 */
  identity: SoulIdentity;
  /** 兴趣领域 */
  interests: SoulInterests;
  /** Facebook-only 公开帖子/评论写作语言；存量与非 Facebook soul 可缺省。 */
  writing_language?: WritingLanguage;
  /** 传统互动规则（向后兼容，ManagerAgent 中已弱化） */
  engagement_rules?: EngagementRules;
  /** 运营员显式配置的确定性互动规则；缺省=完全沿用普通互动链。 */
  mandatory_interactions?: MandatoryInteractionRule[];
  /** 传统浏览状态机（向后兼容） */
  browse_patterns?: BrowsePatterns;
  /** 行为习惯偏好（新版 ManagerAgent 使用） */
  behavior_guidelines?: BehaviorGuidelines;
}
