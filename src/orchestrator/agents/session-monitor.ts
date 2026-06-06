/**
 * SessionMonitor — 会话健康度监控 Agent（纯规则引擎，无 LLM）。
 *
 * 职责：
 * - 检查会话时长、互动配额与冷启动状态
 * - 产出 session.verdict 事件，供下游 Agent 判断是否继续
 *
 * 消费事件：session.stats
 * 产出事件：session.verdict
 */

import type { EventStream, SessionStatsPayload, SessionVerdictPayload } from '../events.js';
import { EVENT_TYPES } from '../events.js';
import type { Soul } from '../../soul/types.js';
import type { RoleAgent } from './base-agent.js';

export class SessionMonitor implements RoleAgent {
  readonly name = 'SessionMonitor';

  async process(stream: EventStream, soul: Soul): Promise<void> {
    // 幂等：若已有 session.verdict 则 return
    if (stream.has(EVENT_TYPES.SESSION_VERDICT)) return;

    // 若无 session.stats 事件则 return
    const statsEvent = stream.find<SessionStatsPayload>(EVENT_TYPES.SESSION_STATS);
    if (!statsEvent) return;

    const { stats, risk } = statsEvent.payload;
    const limits = soul.session_limits;

    const maxDurationMin = limits?.max_duration_min ?? 10;
    const maxLikes = limits?.max_likes ?? 8;
    const maxCollects = limits?.max_collects ?? 5;
    const maxSearches = limits?.max_searches ?? 3;

    const durationMin = stats.durationMs / 60000;
    const warnings: string[] = [];

    // 冷启动检测
    if (stats.views < 5) {
      warnings.push('cold_start: views < 5, interaction disabled');
    }

    // 时长超限
    const durationExceeded = durationMin >= maxDurationMin;
    if (durationExceeded) {
      warnings.push(`duration_exceeded: ${durationMin.toFixed(1)}min >= ${maxDurationMin}min`);
    }

    // 配额检查
    const likesRemaining = risk.remainingActionsToday.like ?? maxLikes;
    const collectsRemaining = risk.remainingActionsToday.collect ?? maxCollects;
    const searchesRemaining = risk.remainingActionsToday.search ?? maxSearches;

    const likesExhausted = likesRemaining <= 0;
    const collectsExhausted = collectsRemaining <= 0;
    const searchesExhausted = searchesRemaining <= 0;

    if (likesExhausted) warnings.push('likes_exhausted');
    if (collectsExhausted) warnings.push('collects_exhausted');
    if (searchesExhausted) warnings.push('searches_exhausted');

    // allow=false 条件：时长超限 或 所有互动配额都归零
    const allQuotasExhausted = likesExhausted && collectsExhausted && searchesExhausted;
    const allow = !durationExceeded && !allQuotasExhausted;

    const payload: SessionVerdictPayload = {
      allow,
      warnings,
      forceAction: !allow ? 'end_session' : undefined,
    };

    stream.emit({
      type: EVENT_TYPES.SESSION_VERDICT,
      source: this.name,
      timestamp: Date.now(),
      payload,
    });
  }
}
