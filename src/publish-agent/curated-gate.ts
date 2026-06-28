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
  /** 相关性所需的最小兴趣命中数（缺省 1）。 */
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
  minTopicOverlap: 1,
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

/**
 * 判定单条笔记是否准入精选语料。
 *
 * 顺序：先过相关性，再过共鸣。
 * 1) 相关性：兴趣关键词以子串形式（大小写不敏感）命中 noteText 的个数 ≥ minTopicOverlap，
 *    或 botCollected（自有收藏豁免相关性）。不相关 → off_topic。
 * 2) 共鸣（满足其一即纳入）：
 *    - botCollected → bot_collect；
 *    - 收藏数达地板 → collect_floor；
 *    - 点赞与收藏齐备、点赞 ≥ ratioLikeFloor 且 收藏/点赞 ≥ ratioMin → collect_ratio；
 *    - 否则 → below_resonance（点赞这类弱信号不单独构成准入）。
 */
export function evaluateAdmission(input: AdmissionInput, config: CuratedGateConfig): AdmissionResult {
  // ① 相关性
  const text = (input.noteText ?? '').toLowerCase();
  let relevanceHits = 0;
  for (const interest of input.accountInterests ?? []) {
    const kw = (interest ?? '').trim().toLowerCase();
    if (kw.length === 0) continue;
    if (text.includes(kw)) relevanceHits += 1;
  }
  const relevant = input.botCollected || relevanceHits >= config.minTopicOverlap;
  if (!relevant) return { admit: false, reason: 'off_topic' };

  // ② 共鸣
  if (input.botCollected) return { admit: true, reason: 'bot_collect' };

  if ((input.collectCount ?? 0) >= config.collectFloor) {
    return { admit: true, reason: 'collect_floor' };
  }

  if (
    input.likeCount != null &&
    input.collectCount != null &&
    input.likeCount >= config.ratioLikeFloor &&
    input.collectCount / input.likeCount >= config.ratioMin
  ) {
    return { admit: true, reason: 'collect_ratio' };
  }

  return { admit: false, reason: 'below_resonance' };
}
