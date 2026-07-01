import type { AlertStore } from '../alerts/index.js';
import type { RiskAction, RiskWindow } from './types.js';

export interface PacingSaturationAlerterOptions {
  alertStore: Pick<AlertStore, 'raise'>;
  clock?: () => number;
  /** 同一 (account, action) 的告警冷却窗（毫秒），默认 20 分钟，防同一过载刷屏。 */
  cooldownMs?: number;
  logger?: Pick<Console, 'warn'>;
}

/** 突发窗（分钟/小时）——每日窗饱和是预期预算用尽，不经此告警。 */
export type BurstWindow = Extract<RiskWindow, 'hour' | 'minute'>;

/**
 * 节奏饱和运维告警器（change decouple-quota-hit-from-risk）。
 *
 * 撞「自己的」速率突发窗不再是风控信号——威胁态只认平台真信号（验证码/阻断浮层/运营手动）。
 * 但过载节奏仍值得运营知道（「该调这个账号的单场时长/停顿，或提高配额档位」），故把被摘掉的
 * 那个信号改道成一条**低优先级运维告警**：
 *   - severity 低档（P2）——是提示、不是阻断；
 *   - 按「账号 + 动作」冷却去重，避免同一过载在冷却窗内反复落库；
 *   - 只写告警存储（AlertStore），**绝不触碰风控状态单写路径**（applySignal/setQuotaLevel/risk_state）。
 *
 * 每日窗（quota:day）饱和不经此告警——那是预期的当日预算用尽，只背压、静默。
 */
export class PacingSaturationAlerter {
  private readonly clock: () => number;
  private readonly cooldownMs: number;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly opts: PacingSaturationAlerterOptions) {
    this.clock = opts.clock ?? Date.now;
    this.cooldownMs = opts.cooldownMs ?? 20 * 60_000;
  }

  /**
   * 记一次突发窗饱和；冷却窗外才 raise 一条低优先级运维告警。同步入口、永不抛（落库异步、错误吞掉）。
   * @returns 是否真的发了告警（冷却窗内压制时返 false，便于测试断言去重）。
   */
  maybe(accountId: string, action: RiskAction, window: BurstWindow): boolean {
    const key = `${accountId}:${action}`;
    const now = this.clock();
    const last = this.lastAlertAt.get(key);
    if (last !== undefined && now - last < this.cooldownMs) return false; // 冷却窗内压制
    this.lastAlertAt.set(key, now);
    const windowLabel = window === 'hour' ? '每小时' : '每分钟';
    Promise.resolve(
      this.opts.alertStore.raise(
        {
          severity: 'P2',
          type: 'pacing_saturation',
          accountId,
          title: `节奏过载：${action} 撞${windowLabel}上限`,
          detail:
            `账号 ${accountId} 的 ${action} 在${windowLabel}突发窗持续撞顶（自我节流背压）。` +
            `建议调低该账号单场时长/停顿，或按需提高其配额档位。此为节奏提示，非平台风控信号、未改风控状态。`,
        },
        now,
      ),
    ).catch((err) => {
      this.opts.logger?.warn?.('[pacing] 告警落库失败:', err instanceof Error ? err.message : String(err));
    });
    return true;
  }
}
