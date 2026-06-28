/**
 * 精选灵感语料的「准入门槛 + 配置」（change curated-inspiration-corpus, Phase 1）。
 *
 * 纯函数、无 PG、自包含。提供两件事：
 * ① 统一的门槛配置（含存储用的 retentionMax / selectTopK，集中一处解析，便于将来按账号覆盖）；
 * ② 单条笔记是否准入精选语料的判定（相关性 + 共鸣双关）。
 *
 * 红线：诚实置空——缺失的计数按「未达标」处理（不编造分数），点赞这类弱信号不单独构成准入。
 */

/** 准入门槛 + 存储相关的统一配置。 */
export interface CuratedGateConfig {
  /** collect 计数地板：自然收藏数达此值即视为有共鸣（缺省 50）。 */
  collectFloor: number;
  /** 收藏/点赞比率门槛（缺省 0.20）。 */
  ratioMin: number;
  /** 比率判定的点赞数下限：低于此值则比率不可信、不予采纳（缺省 80）。 */
  ratioLikeFloor: number;
  /**
   * 评论共鸣预筛的赞数地板（change curated-admission-eval-roles，Phase 3；缺省 10）。
   * 评论第一段预筛 = 评论赞数达此地板 ∪ 已被机器人确认点赞（见 passesCommentResonance）。
   * 注：当前唯一调用方（评论评估角色）消费「确认点赞」事件、confirmedLike 恒真 → 该地板对它是冗余放行；
   * 留作可配地板，供将来「未点赞但高赞评论」之类的来源接入时复用。
   */
  commentLikeFloor: number;
  /**
   * 相关性闸：兴趣命中数需 ≥ 此值（**0 = 关闭硬相关性闸**）。缺省 0。
   * 真机验(2026-06-28)发现：账号兴趣是「描述性长短语」(如「模型横向对比（能力/价格/延迟/上下文/并发）」)、
   * 人设亦明示「兴趣领域不用于硬匹配」，子串硬匹配永不命中 → 把所有笔记误判 off_topic、精选库恒空。
   * 且「打开哪条笔记」已由浏览侧 LLM 按人设把关、相关性在上游已保证，故缺省关闭；质量由 resonance(收藏/比率/自有收藏)独立把。
   */
  minTopicOverlap: number;
  /** 语料保留上限（存储用，放这里供统一解析；缺省 1000）。 */
  retentionMax: number;
  /** 选取灵感时的 Top-K（缺省 8）。 */
  selectTopK: number;
}

/**
 * 缺省门槛配置（数值即 Phase 1 验收基准）。
 *
 * 注意 ratioMin × ratioLikeFloor = 0.20 × 80 = 16 < collectFloor(50)：刻意让「比率分支」真正可达
 * ——它覆盖「收藏数没到绝对地板、但收藏/点赞比率高（点赞≥80 的小众优质）」这类样本（floor 漏掉、
 * 比率捞回）。若把 ratioMin×ratioLikeFloor 抬到 ≥ collectFloor，比率分支会被 floor 完全遮蔽而失效。
 */
export const DEFAULT_CURATED_GATE_CONFIG: CuratedGateConfig = {
  collectFloor: 50,
  ratioMin: 0.2,
  ratioLikeFloor: 80,
  commentLikeFloor: 10,
  // 0 = 关闭硬相关性闸（见 minTopicOverlap 字段说明：真机验发现硬子串匹配长短语兴趣永不命中，
  // 相关性已由浏览侧 LLM 按人设把关）。质量交给下面的 resonance（收藏地板 / 比率 / 自有收藏）。
  minTopicOverlap: 0,
  retentionMax: 1000,
  selectTopK: 8,
};

/**
 * 解析某账号的门槛配置。
 *
 * Phase 1：恒返回缺省（每次返回独立副本，避免调用方意外改动共享常量）。
 * TODO(follow-up): 支持按账号覆盖（如从 soul / 安全配置读取个性化门槛），届时按 accountId 合并到缺省之上。
 */
export function resolveCuratedGateConfig(accountId?: string): CuratedGateConfig {
  void accountId; // Phase 1 暂不按账号区分，先占位入参以稳定签名
  return { ...DEFAULT_CURATED_GATE_CONFIG };
}

/** 单条笔记的准入判定输入。 */
export interface AdmissionInput {
  /** 笔记文本：title + ' ' + body，用于相关性子串匹配。 */
  noteText: string;
  /** 账号兴趣关键词（soul.interests 的 primary + secondary + seed_keywords）。 */
  accountInterests: string[];
  /** 点赞数（缺失为 null，诚实置空）。 */
  likeCount: number | null;
  /** 收藏数（缺失为 null，诚实置空）。 */
  collectCount: number | null;
  /** 是否由 bot 自行收藏：观测路径恒 false；自有收藏经 store 自动纳入，此处供完整判定。 */
  botCollected: boolean;
}

/** 准入判定结果：是否纳入 + 原因码。 */
export interface AdmissionResult {
  admit: boolean;
  reason: string;
}

/** 共鸣预筛（两段式准入第一段）的输入：只看客观共鸣信号，不看相关性。 */
export interface ResonanceInput {
  /** 点赞数（缺失为 null，诚实置空）。 */
  likeCount: number | null;
  /** 收藏数（缺失为 null，诚实置空）。 */
  collectCount: number | null;
}

/** 预筛结果：是否过 + 原因码。 */
export interface ResonanceResult {
  ok: boolean;
  reason: string;
}

/**
 * 笔记第一段「共鸣预筛」（确定性、零 LLM；change curated-admission-eval-roles，Phase 3）。
 * **只判收藏共鸣、不判相关性**——相关性移交第二段的模型评估（读全文）。
 *
 * 过（满足其一即过）：
 *  - 收藏数达地板（collectFloor）→ collect_floor；
 *  - 点赞 + 收藏齐备、点赞 ≥ ratioLikeFloor 且 收藏/点赞 ≥ ratioMin → collect_ratio（小众优质）；
 *  - 否则 → below_resonance（点赞这类弱信号不单独构成共鸣）。
 *
 * 红线：诚实置空——缺失计数按未达标处理（不编造分数）；不过者绝不进第二段（成本红线）。
 */
export function passesResonance(input: ResonanceInput, config: CuratedGateConfig): ResonanceResult {
  if ((input.collectCount ?? 0) >= config.collectFloor) {
    return { ok: true, reason: 'collect_floor' };
  }
  if (
    input.likeCount != null &&
    input.collectCount != null &&
    input.likeCount >= config.ratioLikeFloor &&
    input.collectCount / input.likeCount >= config.ratioMin
  ) {
    return { ok: true, reason: 'collect_ratio' };
  }
  return { ok: false, reason: 'below_resonance' };
}

/** 评论第一段共鸣预筛的输入。 */
export interface CommentResonanceInput {
  /** 该评论的赞数（缺失为 null，诚实置空）。 */
  likeCount: number | null;
  /** 该评论是否已被机器人确认点赞（确认点赞本身是机器人选过 → 放行进第二段评估）。 */
  confirmedLike: boolean;
}

/**
 * 评论第一段共鸣预筛：评论赞数达地板 **∪** 已被机器人确认点赞。两者皆缺 → below_comment_resonance。
 * 红线：诚实置空——赞数缺失按未达标处理（不编造）。
 */
export function passesCommentResonance(input: CommentResonanceInput, config: CuratedGateConfig): ResonanceResult {
  if (input.confirmedLike) return { ok: true, reason: 'confirmed_like' };
  if (input.likeCount != null && input.likeCount >= config.commentLikeFloor) {
    return { ok: true, reason: 'comment_like_floor' };
  }
  return { ok: false, reason: 'below_comment_resonance' };
}

/**
 * 判定单条笔记是否准入精选语料（**整体闸，向后兼容**；Phase 3 后准入主路径走「两段式」，
 * 见 passesResonance + 模型评估角色）。本函数保留：① 给可配的硬相关性子串闸一个入口（缺省关）；
 * ② 既有调用方 / 单测向后兼容。
 *
 * 顺序：先过相关性，再过共鸣。
 * 1) 相关性：兴趣关键词以子串形式（大小写不敏感）命中 noteText 的个数 ≥ minTopicOverlap（**缺省 0=关**），
 *    或 botCollected（自有收藏豁免相关性）。不相关 → off_topic。Phase 3 起相关性由模型评估承担、本子串闸退役为可配。
 * 2) 共鸣：botCollected → bot_collect；其余复用 passesResonance（collect_floor / collect_ratio / below_resonance）。
 */
export function evaluateAdmission(input: AdmissionInput, config: CuratedGateConfig): AdmissionResult {
  // ① 相关性（硬子串闸；缺省 minTopicOverlap=0 即关闭，相关性由模型评估承担——本闸退役为可配）
  const text = (input.noteText ?? '').toLowerCase();
  let relevanceHits = 0;
  for (const interest of input.accountInterests ?? []) {
    const kw = (interest ?? '').trim().toLowerCase();
    if (kw.length === 0) continue;
    if (text.includes(kw)) relevanceHits += 1;
  }
  const relevant = input.botCollected || relevanceHits >= config.minTopicOverlap;
  if (!relevant) return { admit: false, reason: 'off_topic' };

  // ② 共鸣（自有收藏强信号直接过；其余复用 passesResonance）
  if (input.botCollected) return { admit: true, reason: 'bot_collect' };
  const res = passesResonance(input, config);
  return { admit: res.ok, reason: res.reason };
}
