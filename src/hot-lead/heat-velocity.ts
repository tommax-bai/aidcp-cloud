/**
 * 引流线索的「热度速率」度量与过滤闸（change feed-hot-lead-group-comment，段一）。
 *
 * 纯函数、无 PG、自包含、不调 LLM。三件事：
 * ① 把小红书发布相对时刻文本解析成「距今小时数」（不臆造：无法识别→null；裸日期→超窗哨兵）；
 * ② 由点赞数 + 小时数算「每小时点赞」速率；
 * ③ 布尔过滤闸：帖龄≤上限 且 速率≥阈值 且 赞≥最小绝对值 → 判为「热帖线索」。
 *
 * 红线：MUST NOT 静默假成功。发布时刻不可得（null）或超帖龄上限一律判「非线索」，绝不臆造速率、
 * 绝不按绝对量硬塞。这是布尔过滤、不是排序，故不引入任何跨候选比较（前一版方案的非传递比较问题不存在）。
 *
 * 帖龄上限与解析的咬合（见 change design D3/D4）：小红书按「刚刚/分钟/小时/昨天」展示新鲜帖，
 * 再老才跳成裸日期（基本 ≥2 天前）。故上限取小（默认 48h）时，窗内只需处理小时级形态，
 * 裸日期即超窗、直接丢弃——无需按当前时钟换算，解析器保持纯函数、无时钟依赖、可确定性单测。
 */

/** 裸日期（≥天级粒度）的哨兵小时数：必然大于任何合理帖龄上限，交给过滤闸判超窗丢弃。 */
export const STALE_SENTINEL_HOURS = 24 * 3650;

/** 「昨天」统一按此常数（24–48 中点）。2 天窗内精度无意义，保持解析器纯函数、不依赖当前时钟。 */
export const YESTERDAY_HOURS = 36;

/** 「前天」常数（默认 48h 上限下已超窗，仅为可读性显式列出）。 */
export const DAY_BEFORE_YESTERDAY_HOURS = 60;

/**
 * 把发布相对时刻文本解析为「距今小时数」。
 * - 「刚刚 / X分钟前」→ 0（不足 1 小时，速率用 FLOOR 兜底）
 * - 「X小时前」→ X
 * - 「昨天…」→ 36（常数，见 YESTERDAY_HOURS）
 * - 「前天…」→ 60
 * - 「X天前」→ X*24
 * - 裸日期（MM-DD / YYYY-MM-DD / YYYY年MM月DD日）→ STALE_SENTINEL_HOURS（超窗）
 * - 剥离「编辑于」前缀；按 token 匹配（尾随地区名不影响）；无法识别 → null（不臆造）
 */
export function parsePublishedHoursAgo(text?: string | null): number | null {
  if (!text) return null;
  let s = text.trim();
  if (!s) return null;
  // 剥离「编辑于」前缀（尾随地区名无需剥离——下面按 token 匹配而非整串相等）
  s = s.replace(/^编辑于\s*/, '');

  if (/刚刚/.test(s)) return 0;
  if (/\d+\s*分钟前/.test(s)) return 0;

  const hour = s.match(/(\d+)\s*小时前/);
  if (hour) return parseInt(hour[1], 10);

  if (/昨天/.test(s)) return YESTERDAY_HOURS;
  if (/前天/.test(s)) return DAY_BEFORE_YESTERDAY_HOURS;

  const day = s.match(/(\d+)\s*天前/);
  if (day) return parseInt(day[1], 10) * 24;

  // 裸日期：MM-DD / M-D / YYYY-MM-DD（含 / 与 年月日 变体）
  if (/(?:\d{4}[-/年])?\d{1,2}[-/月]\d{1,2}日?/.test(s)) return STALE_SENTINEL_HOURS;

  return null;
}

/** 每小时点赞速率 = 点赞数 / max(小时数, 分母下限)。分母下限挡刚发布（小时数=0）除零/爆表。 */
export function heatVelocity(likeCount: number, hoursAgo: number, floorHours: number): number {
  return likeCount / Math.max(hoursAgo, floorHours);
}

/** 过滤闸配置（默认为保守占位，真机看速率分布再经后台校准——见 change Open Questions）。 */
export interface HotLeadGateConfig {
  /** 帖龄上限（小时）：第一道闸，超龄/裸日期直接淘汰。默认 48（2 天）。 */
  maxAgeHours: number;
  /** 每小时点赞速率阈值：达此值算「涨得快」。默认 300。 */
  velocityMin: number;
  /** 最小绝对赞数：挡小基数假热（如 0.5h 20 赞）。默认 500。 */
  minLikeFloor: number;
  /** 速率分母下限（小时）：挡刚发布除零。默认 1。 */
  floorHours: number;
}

/** 保守占位默认值。段一真机看分布，段一/后台再校准（不是最终值）。 */
export const DEFAULT_HOT_LEAD_GATE_CONFIG: HotLeadGateConfig = {
  maxAgeHours: 48,
  velocityMin: 300,
  minLikeFloor: 500,
  floorHours: 1,
};

export type HotLeadReason =
  | 'ok'
  | 'unparseable_time'
  | 'too_old'
  | 'low_likes'
  | 'low_velocity';

export interface HotLeadEval {
  /** 是否判为「热帖线索」。 */
  isLead: boolean;
  /** 解析出的距今小时数（null=不可得，STALE_SENTINEL_HOURS=裸日期超窗）。 */
  hoursAgo: number | null;
  /** 每小时点赞速率（小时不可得时为 null）。 */
  velocity: number | null;
  /** 判定原因，供段一观测/日志与去重前置排查。 */
  reason: HotLeadReason;
}

/**
 * 纯确定性过滤闸：判定某帖是否「热帖线索」。
 * 顺序即闸序：小时不可得 → 帖龄超上限 → 赞不足 → 速率不足 → 命中。
 */
export function evaluateHotLead(
  input: { likeCount: number; publishedAtText?: string | null },
  config: HotLeadGateConfig = DEFAULT_HOT_LEAD_GATE_CONFIG,
): HotLeadEval {
  const hoursAgo = parsePublishedHoursAgo(input.publishedAtText);
  if (hoursAgo === null) {
    return { isLead: false, hoursAgo: null, velocity: null, reason: 'unparseable_time' };
  }
  if (hoursAgo > config.maxAgeHours) {
    return { isLead: false, hoursAgo, velocity: null, reason: 'too_old' };
  }
  const velocity = heatVelocity(input.likeCount, hoursAgo, config.floorHours);
  if (input.likeCount < config.minLikeFloor) {
    return { isLead: false, hoursAgo, velocity, reason: 'low_likes' };
  }
  if (velocity < config.velocityMin) {
    return { isLead: false, hoursAgo, velocity, reason: 'low_velocity' };
  }
  return { isLead: true, hoursAgo, velocity, reason: 'ok' };
}
