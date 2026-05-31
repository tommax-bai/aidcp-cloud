/**
 * 发布触发器：判断当前是否满足发布条件（混合触发）。
 *
 * 触发逻辑（两个内容条件 + 时间门槛同时满足）：
 * - 硬下限：距上次发布 >= minTimeSinceLastPublishHours 小时（未到坚决不发）；
 * - 正常路径：新概念 >= minNewConcepts 且 上次发布后点赞 >= minLikedSinceLastPublish；
 * - 软上限：若距上次发布 >= maxSilenceHours（太久没发），放宽内容量要求——
 *   只要有 >= 1 个新概念即可发（点赞门槛同时放宽），避免账号长期沉默。
 *
 * 纯函数实现：度量由调用方注入（便于单测覆盖所有条件组合）。
 */

import {
  DEFAULT_TRIGGER_CONFIG,
  type PublishTriggerConfig,
  type TriggerMetrics,
  type TriggerDecision,
} from './types.js';

/** 发布触发器。 */
export class PublishTrigger {
  private readonly config: PublishTriggerConfig;

  constructor(config: Partial<PublishTriggerConfig> = {}) {
    this.config = { ...DEFAULT_TRIGGER_CONFIG, ...config };
  }

  /** 当前生效的配置（只读副本）。 */
  getConfig(): PublishTriggerConfig {
    return { ...this.config };
  }

  /**
   * 评估是否应当发布。
   * @param metrics 当前度量（距上次发布小时数 / 新概念数 / 点赞数）
   */
  evaluate(metrics: TriggerMetrics): TriggerDecision {
    const { minTimeSinceLastPublishHours, minNewConcepts, minLikedSinceLastPublish, maxSilenceHours } =
      this.config;

    // 硬下限：距上次发布不足，坚决不发。
    if (metrics.hoursSinceLastPublish < minTimeSinceLastPublishHours) {
      return {
        shouldPublish: false,
        relaxed: false,
        reason: `距上次发布仅 ${fmt(metrics.hoursSinceLastPublish)}h < ${minTimeSinceLastPublishHours}h（时间硬下限未到）`,
      };
    }

    // 软上限：太久没发，放宽内容量要求（concepts >= 1 即可）。
    const relaxed = metrics.hoursSinceLastPublish >= maxSilenceHours;
    if (relaxed) {
      if (metrics.newConceptCount >= 1) {
        return {
          shouldPublish: true,
          relaxed: true,
          reason: `已沉默 ${fmt(metrics.hoursSinceLastPublish)}h >= ${maxSilenceHours}h，放宽内容量要求（新概念 ${metrics.newConceptCount} >= 1）`,
        };
      }
      return {
        shouldPublish: false,
        relaxed: true,
        reason: `已沉默 ${fmt(metrics.hoursSinceLastPublish)}h 但无任何新概念（>=1 即可）`,
      };
    }

    // 正常路径：新概念 + 点赞数同时达标。
    const conceptOk = metrics.newConceptCount >= minNewConcepts;
    const likedOk = metrics.likedSinceLastPublish >= minLikedSinceLastPublish;
    if (conceptOk && likedOk) {
      return {
        shouldPublish: true,
        relaxed: false,
        reason: `条件满足：新概念 ${metrics.newConceptCount} >= ${minNewConcepts} 且 点赞 ${metrics.likedSinceLastPublish} >= ${minLikedSinceLastPublish}`,
      };
    }

    const missing: string[] = [];
    if (!conceptOk) missing.push(`新概念 ${metrics.newConceptCount} < ${minNewConcepts}`);
    if (!likedOk) missing.push(`点赞 ${metrics.likedSinceLastPublish} < ${minLikedSinceLastPublish}`);
    return {
      shouldPublish: false,
      relaxed: false,
      reason: `内容量不足：${missing.join('；')}`,
    };
  }
}

/** 把可能是 Infinity 的小时数格式化为可读字符串。 */
function fmt(h: number): string {
  if (!Number.isFinite(h)) return '∞';
  return String(Math.round(h * 10) / 10);
}