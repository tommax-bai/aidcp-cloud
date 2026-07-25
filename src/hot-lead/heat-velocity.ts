/**
 * 引流线索的「热度速率」度量与过滤闸（change feed-hot-lead-group-comment，段一）。
 *
 * 纯函数、无 PG、自包含、不调 LLM。三件事：
 * ① 复用统一来源发布时间标准化结果派生「距今小时数」（不臆造：无法识别→null）；
 * ② 由点赞数 + 小时数算「每小时点赞」速率；
 * ③ 布尔过滤闸：帖龄≤上限 且 速率≥阈值 且 赞≥最小绝对值 → 判为「热帖线索」。
 *
 * 红线：MUST NOT 静默假成功。发布时刻不可得（null）或超帖龄上限一律判「非线索」，绝不臆造速率、
 * 绝不按绝对量硬塞。这是布尔过滤、不是排序，故不引入任何跨候选比较（前一版方案的非传递比较问题不存在）。
 *
 * 解析以 note.detail 事件 ts 为显式观测锚；日精度值按当日最年轻可能时刻保守计算帖龄。
 */
import { normalizeSourcePublishedTime, sourcePublishedAgeHours } from '../time/source-published-time.js';
import { DEFAULT_HOT_LEAD_GATE_CONFIG, type HotLeadGateConfig } from '../kernel/hot-lead-gate-config.js';

/**
 * 把发布时刻文本解析为距事件观测锚的小时数。日精度按该日最年轻可能时刻计算，
 * 避免把代表用的本地零点伪装成平台提供的精确时刻。
 */
export function parsePublishedHoursAgo(text: string | null | undefined, observedAt: number): number | null {
  const normalized = normalizeSourcePublishedTime(text, { observedAt });
  return normalized ? sourcePublishedAgeHours(normalized) : null;
}

/** 每小时点赞速率 = 点赞数 / max(小时数, 分母下限)。分母下限挡刚发布（小时数=0）除零/爆表。 */
export function heatVelocity(likeCount: number, hoursAgo: number, floorHours: number): number {
  return likeCount / Math.max(hoursAgo, floorHours);
}

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
  input: { likeCount: number; publishedAtText?: string | null; observedAt: number },
  config: HotLeadGateConfig = DEFAULT_HOT_LEAD_GATE_CONFIG,
): HotLeadEval {
  const hoursAgo = parsePublishedHoursAgo(input.publishedAtText, input.observedAt);
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
