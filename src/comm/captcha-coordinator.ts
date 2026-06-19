/**
 * 验证码 / 阻断弹窗事件协调器（消费 edge → cloud 的 risk.captcha_detected / risk.captcha_cleared）。
 *
 * detected：
 *   ① 据 kind 迁移归属账号风控态（captcha=强信号→restricted；unknown=弱信号→warned）——账号风控终态云端单写；
 *   ② 按 edge 暂停下发（pusher.pauseEdge，session.end 不受影响，见 ws-server）；
 *   ③ 去重冷却后发飞书 notify-only 告警（含账号 / 机器 / 远程地址），发送失败记录不静默。
 * cleared：
 *   解除该 edge 暂停（pusher.resumeEdge）；风控态不自动回滚（由状态机恢复窗口 / 人工恢复驱动）。
 *
 * 全程不阻塞 edge、不写信号文件、不需要审批按钮——验证码是单向通知，边缘靠 DOM 清除自动恢复。
 */

import { buildAlertCard } from '../feishu/cards.js';
import type { FeishuMessenger } from '../feishu/messenger.js';
import type { AlertData } from '../feishu/types.js';
import type { RiskController } from '../risk/index.js';
import type { CaptchaClearedPayload, CaptchaDetectedPayload } from './protocol.js';
import type { EdgePusher, EdgeSession } from './ws-server.js';

export interface CaptchaCoordinatorDeps {
  riskController: RiskController;
  messenger?: Pick<FeishuMessenger, 'sendCard'>;
  /** 解析目标飞书群（注入，便于与发布审批共用解析口径）。 */
  resolveChatId: () => Promise<string>;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
  clock?: () => number;
  /** 同一 edge 验证码告警的冷却窗（毫秒），默认 10 分钟，防 edge 循环验证码刷屏。 */
  cooldownMs?: number;
}

export class CaptchaCoordinator {
  private readonly clock: () => number;
  private readonly cooldownMs: number;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  /** 每 edge 上次发卡时刻，用于冷却去重。 */
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly deps: CaptchaCoordinatorDeps) {
    this.clock = deps.clock ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? 10 * 60_000;
    this.logger = deps.logger ?? console;
  }

  async onDetected(
    payload: CaptchaDetectedPayload,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<void> {
    const edgeId = payload.edgeId ?? session.edgeId;
    const accountId = payload.accountId ?? session.accountId;

    // ① 风控态迁移（云端单写）：captcha=强信号→restricted；unknown=弱信号→warned。
    try {
      await this.deps.riskController.applySignal({ kind: payload.kind === 'captcha' ? 'confirmed' : 'light' });
    } catch (err) {
      this.logger.error('[captcha] applySignal 失败:', err instanceof Error ? err.message : String(err));
    }
    const status = this.deps.riskController.getState().status;

    // ② 按 edge 暂停下发（session.end 仍可达）。
    if (edgeId && pusher) pusher.pauseEdge(edgeId);

    this.logger.log('[captcha] detected', { edgeId, accountId, kind: payload.kind, status, url: payload.url });

    // ③ 去重冷却后发飞书告警。
    await this.maybeAlert(payload, session, edgeId, accountId, status);
  }

  async onCleared(
    payload: CaptchaClearedPayload,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<void> {
    const edgeId = payload.edgeId ?? session.edgeId;
    if (edgeId && pusher) pusher.resumeEdge(edgeId);
    // 清除冷却记录：下次验证码可立即再次告警（一次新事件不被旧冷却压住）。
    if (edgeId) this.lastAlertAt.delete(edgeId);
    this.logger.log('[captcha] cleared，恢复下发', {
      edgeId,
      accountId: payload.accountId ?? session.accountId,
    });
    // 风控态不自动回滚：由状态机恢复窗口或飞书人工恢复命令驱动降级。
  }

  private async maybeAlert(
    payload: CaptchaDetectedPayload,
    session: EdgeSession,
    edgeId: string | undefined,
    accountId: string | undefined,
    status: string,
  ): Promise<void> {
    if (!this.deps.messenger) return;
    const key = edgeId ?? 'unknown-edge';
    const now = this.clock();
    const last = this.lastAlertAt.get(key);
    if (last !== undefined && now - last < this.cooldownMs) {
      this.logger.log('[captcha] 冷却窗内，跳过重复告警', { edgeId: key, sinceMs: now - last });
      return;
    }
    this.lastAlertAt.set(key, now);

    let chatId = '';
    try {
      chatId = await this.deps.resolveChatId();
    } catch (err) {
      this.logger.warn('[captcha] 解析目标群失败:', err instanceof Error ? err.message : String(err));
    }
    if (!chatId) {
      this.logger.error('[captcha] 无可用飞书群，告警未发出', { edgeId: key });
      return;
    }

    const machine = session.machineLabel ?? edgeId ?? '未知机器';
    const detail = [
      `**类别**：${payload.kind === 'captcha' ? '验证码挑战' : '未知阻断弹窗'}`,
      `**机器**：${machine}`,
      session.remoteAddr ? `**远程地址**：${session.remoteAddr}` : '',
      `**Edge**：${edgeId ?? '未知'}`,
      `**风控态**：已置 ${status}`,
      payload.url ? `**页面**：${payload.url}` : '',
      '请远程连到该机器人工处置；处置后边缘会自动恢复浏览。',
    ]
      .filter(Boolean)
      .join('\n');

    const alert: AlertData = {
      severity: payload.kind === 'captcha' ? 'P0' : 'P1',
      title: payload.kind === 'captcha' ? '验证码弹出' : '未知阻断弹窗',
      accountId,
      detail,
    };

    try {
      await this.deps.messenger.sendCard(chatId, buildAlertCard(alert));
      this.logger.log('[captcha] 飞书告警已发', { edgeId: key, chatId, severity: alert.severity });
    } catch (err) {
      // 红线：发送失败记录、不静默吞。
      this.logger.error('[captcha] 飞书告警发送失败:', err instanceof Error ? err.message : String(err));
    }
  }
}
