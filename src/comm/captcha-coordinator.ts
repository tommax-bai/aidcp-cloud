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
import type { AlertData, AlertSeverity } from '../feishu/types.js';
import type { RiskController } from '../risk/index.js';
import type { AlertStore } from '../alerts/index.js';
import type {
  BlockingOverlayDomFeaturePayload,
  BlockingOverlaySnapshotPayload,
  CaptchaClearedPayload,
  CaptchaDetectedPayload,
} from './protocol.js';
import type { EdgePusher, EdgeSession } from './ws-server.js';
import type { CaptchaAssistDetectedResult } from './captcha-assist.js';
import { isFacebookThrottleText } from './facebook-throttle-signals.js';

export interface CaptchaAssistCoordinatorPort {
  onDetected(
    payload: CaptchaDetectedPayload,
    session: EdgeSession,
    status: string,
  ): Promise<CaptchaAssistDetectedResult | null> | CaptchaAssistDetectedResult | null;
  onCleared(edgeId: string | undefined, accountId?: string): void;
}

export interface CaptchaCoordinatorDeps {
  /** retire-default-account：按真实账号解析该账号的 RiskController（替代单租户全局 controller）。 */
  resolveController: (accountId: string) => Promise<RiskController>;
  messenger?: Pick<FeishuMessenger, 'sendCard'>;
  /** 解析目标飞书群（注入，便于与发布审批共用解析口径）。 */
  resolveChatId: () => Promise<string>;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
  clock?: () => number;
  /** 同一 edge 验证码告警的冷却窗（毫秒），默认 10 分钟，防 edge 循环验证码刷屏。 */
  cooldownMs?: number;
  /** 告警日志（V1 task 9.5）：飞书卡发送点写入、清除点 resolveByEdge。未注入则不落库（向后兼容）。 */
  alertStore?: Pick<AlertStore, 'raise' | 'resolveByEdge'>;
  /** 账号展示名读取。仅用于飞书卡片文案；账号归属仍使用 accountId。 */
  getAccountName?: (accountId: string) => string | null | undefined;
  /** 云端协助处置通道。未注入或未配置时保留原远程桌面处置行为。 */
  assist?: CaptchaAssistCoordinatorPort;
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

    // ① 风控态迁移（云端单写，retire-default-account：按真实账号解析 controller，绝不回落全局 default）。
    //    captcha=强信号→restricted；unknown=弱信号→warned。缺账号=上游缺陷，honest-fail 跳过迁移 + 告警。
    let status = 'unknown';
    if (!accountId) {
      this.logger.warn('[captcha] detected 缺 accountId（握手应已保证）— 跳过风控迁移，绝不回落 default');
    } else {
      try {
        const controller = await this.deps.resolveController(accountId);
        // Facebook 软阻断/限流浮层（"Action Blocked"/"we limit how often you can do this" 等，change
        // account-nurture-discipline-spine §3）：激进退避——即便 kind='unknown'，只要 overlay 文案命中
        // FB 限流词库，也把信号升级为 confirmed（→restricted，只留浏览），不足以靠 warned ×0.7 刹车。
        // 只喂 applySignal 输入侧、不改状态机迁移表；终态仍云端 RiskController 单写。小红书 overlay 不命中 → 零回归。
        const throttled = isFacebookThrottleText(payload.overlay?.text);
        const signalKind = payload.kind === 'captcha' || throttled ? 'confirmed' : 'light';
        if (throttled && payload.kind !== 'captcha') {
          this.logger.log('[captcha] Facebook 限流软阻断信号命中 → 升级 restricted 退避', { edgeId, accountId });
        }
        await controller.applySignal({ kind: signalKind });
        status = controller.getState().status;
      } catch (err) {
        this.logger.error('[captcha] applySignal 失败:', err instanceof Error ? err.message : String(err));
      }
    }

    // ② 按 edge 暂停下发（session.end 仍可达）。
    if (edgeId && pusher) pusher.pauseEdge(edgeId);

    let assistActionUrl: string | undefined;
    try {
      const assist = await this.deps.assist?.onDetected(payload, session, status);
      assistActionUrl = assist?.actionUrl || undefined;
    } catch (err) {
      this.logger.error('[captcha] 创建云端协助事件失败:', err instanceof Error ? err.message : String(err));
    }

    this.logger.log('[captcha] detected', {
      edgeId,
      accountId,
      kind: payload.kind,
      status,
      url: payload.url,
      overlay: summarizeOverlayForLog(payload.overlay),
    });

    // ③ 去重冷却后发飞书告警。
    await this.maybeAlert(payload, session, edgeId, accountId, status, assistActionUrl);
  }

  async onCleared(
    payload: CaptchaClearedPayload,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<void> {
    const edgeId = payload.edgeId ?? session.edgeId;
    if (edgeId && pusher) pusher.resumeEdge(edgeId);
    try {
      this.deps.assist?.onCleared(edgeId, payload.accountId ?? session.accountId);
    } catch (err) {
      this.logger.error('[captcha] 标记云端协助事件已清除失败:', err instanceof Error ? err.message : String(err));
    }
    // 清除冷却记录：下次验证码可立即再次告警（一次新事件不被旧冷却压住）。
    if (edgeId) this.lastAlertAt.delete(edgeId);
    // 验证码清除点：按 edge 解决其未解决告警（V1 task 9.5）。
    if (edgeId && this.deps.alertStore) {
      try {
        const resolved = await this.deps.alertStore.resolveByEdge(edgeId, this.clock());
        if (resolved > 0) this.logger.log('[captcha] 告警已解决', { edgeId, resolved });
      } catch (err) {
        this.logger.error('[captcha] 告警解决失败:', err instanceof Error ? err.message : String(err));
      }
    }
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
    assistActionUrl?: string,
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

    const severity: AlertSeverity = payload.kind === 'captcha' ? 'P0' : 'P1';
    const title = payload.kind === 'captcha' ? '验证码弹出' : '未知阻断弹窗';
    const detail = buildCaptchaAlertDetail(payload, session, edgeId, status, Boolean(assistActionUrl));

    // 告警落库（V1 task 9.5）：与飞书投递解耦——即便无群/发送失败，告警事件仍被记录。
    if (this.deps.alertStore) {
      try {
        await this.deps.alertStore.raise(
          {
            severity,
            type: payload.kind === 'captcha' ? 'captcha' : 'block',
            accountId,
            edgeId,
            title,
            detail,
          },
          now,
        );
      } catch (err) {
        // 红线：落库失败记录、不静默吞；不阻断飞书告警投递。
        this.logger.error('[captcha] 告警落库失败:', err instanceof Error ? err.message : String(err));
      }
    }

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

    const alert: AlertData = {
      severity,
      title,
      accountId,
      accountName: accountId ? normalizeAccountName(this.deps.getAccountName?.(accountId)) : undefined,
      detail,
      ...(assistActionUrl ? { actionText: '打开协助处理', actionUrl: assistActionUrl } : {}),
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

function normalizeAccountName(name: string | null | undefined): string | undefined {
  const clean = name?.trim();
  return clean || undefined;
}

function buildCaptchaAlertDetail(
  payload: CaptchaDetectedPayload,
  session: EdgeSession,
  edgeId: string | undefined,
  status: string,
  hasAssistAction: boolean,
): string {
  const machine = session.machineLabel ?? edgeId ?? '未知机器';
  const firstUrl = payload.overlay?.firstDetectedUrl ?? payload.url;
  const lines = [
    `**类别**：${payload.kind === 'captcha' ? '验证码挑战' : '未知阻断弹窗'}`,
    `**机器**：${machine}`,
    session.remoteAddr ? `**远程地址**：${session.remoteAddr}` : '',
    `**Edge**：${edgeId ?? '未知'}`,
    `**风控态**：已置 ${status}`,
    firstUrl ? `**首次检测 URL**：${firstUrl}` : '',
    payload.url && payload.url !== firstUrl ? `**上报时页面**：${payload.url}` : '',
    ...formatOverlaySnapshotLines(payload.overlay),
    hasAssistAction
      ? '可点击卡片按钮在云端协助页处理；远程连接该机器仍可作为兜底。处置后边缘会自动复检并恢复浏览。'
      : '请远程连到该机器人工处置；处置后边缘会自动恢复浏览。',
  ];
  return lines.filter(Boolean).join('\n');
}

function formatOverlaySnapshotLines(overlay: BlockingOverlaySnapshotPayload | undefined): string[] {
  if (!overlay) return [];
  const lines = [
    overlay.text ? `**遮罩文案**：${clip(overlay.text, 500)}` : '',
    overlay.dom ? `**DOM 特征**：${formatDomFeature(overlay.dom)}` : '',
  ];
  if (overlay.candidates.length > 1) {
    lines.push(`**候选遮罩数**：${overlay.candidates.length}`);
  }
  return lines.filter(Boolean);
}

function formatDomFeature(dom: BlockingOverlayDomFeaturePayload): string {
  const parts = [
    `tag=${dom.tag}`,
    dom.id ? `id=${clip(dom.id, 80)}` : '',
    dom.className ? `class=${clip(dom.className, 160)}` : '',
    dom.role ? `role=${dom.role}` : '',
    dom.ariaModal ? `aria-modal=${dom.ariaModal}` : '',
    dom.selector ? `selector=${clip(dom.selector, 180)}` : '',
    dom.rect
      ? `rect=${dom.rect.width}x${dom.rect.height}@${dom.rect.x},${dom.rect.y}`
      : '',
    dom.style?.position ? `position=${dom.style.position}` : '',
    dom.style?.zIndex ? `zIndex=${dom.style.zIndex}` : '',
    typeof dom.hasClose === 'boolean' ? `hasClose=${dom.hasClose}` : '',
    typeof dom.hasIframe === 'boolean' ? `hasIframe=${dom.hasIframe}` : '',
    dom.iframeSrcs && dom.iframeSrcs.length > 0 ? `iframeSrc=${clip(dom.iframeSrcs.join(', '), 180)}` : '',
    dom.matchReasons && dom.matchReasons.length > 0 ? `match=${dom.matchReasons.join(',')}` : '',
  ];
  return parts.filter(Boolean).join('; ');
}

function summarizeOverlayForLog(overlay: BlockingOverlaySnapshotPayload | undefined): Record<string, unknown> | undefined {
  if (!overlay) return undefined;
  return {
    kind: overlay.kind,
    firstDetectedUrl: overlay.firstDetectedUrl,
    text: overlay.text,
    dom: overlay.dom,
    candidateCount: overlay.candidates.length,
  };
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}
