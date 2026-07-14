/**
 * UiSnapshotService —— 陪伴界面数据下发（change edge-companion-ui 8.1）。
 *
 * 职责：把「边缘看不到、只有云端知道」的界面数据经 `ui.snapshot` 定向推给该账号的在线边缘：
 *  - hello 注册完成后：全量快照（小红书昵称 + 最近成功发布摘要 + 在途候审/已批状态 + 待审稿件预览）；
 *  - 发布审批生命周期变化时：增量状态（pending / approved / submitted / rejected / failed）。
 *
 * 红线：
 *  - 宁缺毋假：无数据的字段不带；快照全空不发包；已拒草稿在 hello 快照不回放（拒绝时刻已实时推过，
 *    重启不翻旧账、无事件不造活跃）。
 *  - published 不经此通道（边缘在同页取到 postId 后自知并本地发射，避免双源重复）。
 *  - 推送尽力而为：账号无在线边缘/连接刚断（sent=0）如实记日志放弃，绝不重试风暴。
 *    hello 快照可重建的只有**持久可查**的态（昵称/最近发布/候审 pending/已批 approved）；
 *    终态（rejected/failed）只在转移时刻推送一次，边缘离线错过即不回放——壳侧配套约定：
 *    核心（重）启动时清发布卡在途态、由 hello 快照重建，故错过的终态不会滞留成陈卡。
 *    推送失败绝不影响发布主链路（全部 try/catch 自吞）。
 *
 * 拒绝决定现在会把 publish_log 从 pending_approval 持久化为 needs_review；hello 快照只回放仍在
 * pending_approval 的真候审/已批在途。即使 /tmp 信号丢失，已拒草稿也不会重新冒成 pending。
 */

import {
  makeEnvelope,
  type Envelope,
  type UiBrowserStandbyPayload,
  type UiDailyUsagePayload,
  type UiPublishPreviewPayload,
  type UiSnapshotPayload,
} from './protocol.js';
import { randomUUID } from 'node:crypto';

/** 云端可推送的发布审批状态（published 由边缘同页取到 postId 后本地发射，不在此列）。 */
export type PublishUiState = 'pending' | 'approved' | 'submitted' | 'rejected' | 'failed';
type TimerHandle = ReturnType<typeof setTimeout>;

const MIN_DAILY_USAGE_REFRESH_DELAY_MS = 1_000;

/**
 * 待机提示在场时的保底续跳间隔（change standby-covers-idle-waits）。
 * 与今日用量分钟窗的既有实际节奏（约 60s）一致，故不引入额外推送负载；它的作用是让链在
 * 「今日用量缺失 / 没有窗口带刷新时刻」时**仍然活着**——那是冷待机账号唯一的唤醒路径。
 */
const STANDBY_REFRESH_INTERVAL_MS = 60_000;

export interface UiSnapshotDeps {
  pusher: { pushToEdges(env: Envelope, edgeId?: string): number };
  /** 解析绑定该账号的在线边缘 edgeId；无在线节点返回 null（推送如实放弃）。 */
  resolveEdgeIdForAccount: (accountId: string) => string | null;
  /** 账号主数据昵称（AccountStore 同步缓存读）；无昵称返回 null（不发 identity）。 */
  getNickname?: (accountId: string) => string | null;
  /** 该账号是否已绑人设（persona 存储权威判据）；用于 hello 快照下发 personaBound 信号（change persona-wizard-onboarding-fixes）。 */
  isPersonaBound?: (accountId: string) => boolean;
  /** 最近一次成功发布摘要（PublishLogStore.lastPublishedForAccount）。 */
  lastPublishedForAccount?: (accountId: string) => Promise<{ title: string | null; at: number } | null>;
  /** 最新待审草稿（PublishLogStore.pendingApprovalForAccount）。 */
  pendingApprovalForAccount?: (accountId: string) => Promise<{ id: number; title: string | null } | null>;
  /** 最新待审稿件完整预览；不包含原稿来源字段。 */
  pendingPublishPreviewForAccount?: (accountId: string) => Promise<UiPublishPreviewPayload | null>;
  /** 读授权信号：null=未决（真候审）；approved=true=已批在途；false=已拒（hello 不回放）。 */
  readApproval?: (requestId: string) => Promise<{ approved: boolean } | null>;
  todayUsageForAccount?: (accountId: string, edgeId?: string) => Promise<UiDailyUsagePayload | null>;
  browserStandbyForAccount?: (accountId: string, edgeId?: string) => Promise<UiBrowserStandbyPayload | null>;
  clock?: () => number;
  idGen?: () => string;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/** 界面「编号」形态（与飞书审批卡「编号」字段同源：发布记录 id）。 */
export function publishUiCode(recordId: number): string {
  return `#${recordId}`;
}

export class UiSnapshotService {
  private readonly deps: UiSnapshotDeps;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly dailyUsageTimers = new Map<string, TimerHandle>();

  constructor(deps: UiSnapshotDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? Date.now;
    this.idGen = deps.idGen ?? (() => `uisnap-${randomUUID()}`);
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.logger = deps.logger ?? console;
  }

  /**
   * hello 注册完成后的全量快照（须在 ws-server 把连接放进推送表**之后**调用，
   * 否则 pushToEdges 命中 0 接收者——见 nickname-enricher 同款前科）。
   */
  async pushHelloSnapshot(accountId: string | undefined, edgeId: string | undefined): Promise<void> {
    if (!accountId || !edgeId) return;
    // 人设绑定态先单独发一包（红线：这个 bit 是零 I/O 的内存判据，绝不能排在下面五个 PG/fs 往返之后）。
    // 边缘客户端拿它决定「要不要弹人设向导」；它每晚到一毫秒，客户端就多一毫秒分不清「云端说没有」和
    // 「云端还没说」。真机上快照迟到 → 已设置人设的账号被误弹向导（工程师大白）。
    this.pushPersonaBound(accountId, edgeId);
    try {
      const payload: UiSnapshotPayload = {};

      const nickname = this.deps.getNickname?.(accountId) ?? null;
      if (nickname && nickname.trim()) payload.account = { id: accountId, nickname: nickname.trim() };

      const last = await this.deps.lastPublishedForAccount?.(accountId)?.catch(() => null);
      if (last?.title && Number.isFinite(last.at)) payload.lastPublish = { title: last.title, at: last.at };

      const preview = await this.deps.pendingPublishPreviewForAccount?.(accountId)?.catch(() => null);
      const pending = preview
        ? { id: preview.recordId, title: preview.title || null }
        : await this.deps.pendingApprovalForAccount?.(accountId)?.catch(() => null);
      if (pending) {
        const decision = (await this.deps.readApproval?.(`publish-${pending.id}`)?.catch(() => null)) ?? null;
        // 无信号=真候审；已批=下发在途；已拒=不回放（拒绝时刻已实时推过）。
        const state: PublishUiState | null = decision == null ? 'pending' : decision.approved ? 'approved' : null;
        if (state) {
          if (preview) payload.publishPreview = preview;
          payload.publish = {
            state,
            code: publishUiCode(pending.id),
            ...(pending.title ? { title: pending.title } : {}),
          };
        }
      }

      const dailyUsage = this.deps.todayUsageForAccount
        ? await this.deps.todayUsageForAccount(accountId, edgeId).catch(() => null)
        : null;
      if (dailyUsage) payload.dailyUsage = dailyUsage;

      const browserStandby = this.deps.browserStandbyForAccount
        ? await this.deps.browserStandbyForAccount(accountId, edgeId).catch(() => null)
        : null;
      if (browserStandby) payload.browserStandby = browserStandby;

      // 人设绑定态已在本方法开头单独先发（见那里的注释），此处不再重复带上。
      if (!payload.account && !payload.lastPublish && !payload.publish && !payload.publishPreview && !payload.dailyUsage && !payload.browserStandby) return; // 全空不发包
      const sent = this.push(accountId, edgeId, payload, 'hello快照');
      // hello 是这条周期链的唯一起点。待机提示在场却不起链 = 该账号一旦让位待机就再也醒不过来。
      if (sent > 0) this.scheduleSnapshotRefresh(accountId, edgeId, dailyUsage ?? null, Boolean(browserStandby));
    } catch (err) {
      this.logger.warn(
        `[ui-snapshot] hello 快照构建失败 account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 人设绑定态推送：**true 与 false 都发**（change persona-bound-tristate）。
   *
   * 云端是人设状态的唯一权威写方，它有资格诚实地说「这个账号没有人设」。旧契约「仅为 true 时下发」把
   * 「云端说没有」和「云端还没说」压成了边缘侧同一个 false，于是边缘只能靠一个 6 秒宽限去猜——猜错就
   * 给已设置人设的账号弹向导。三态（true / false / 缺省=未知）让「未知」在类型上就无法触发弹窗。
   *
   * 绑定 / 解绑后即时重推，不必等下一次握手（否则客户端里「清空人设=解绑」要到重启才可见）。
   */
  pushPersonaBound(accountId: string, edgeId?: string): void {
    try {
      if (!accountId || !this.deps.isPersonaBound) return;
      const target = edgeId ?? this.deps.resolveEdgeIdForAccount(accountId);
      if (!target) return; // 无在线边缘：如实放弃，下次握手补
      this.push(accountId, target, { personaBound: this.deps.isPersonaBound(accountId) }, 'personaBound');
    } catch (err) {
      this.logger.warn(
        `[ui-snapshot] personaBound 推送异常 account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 发布审批状态实时推送。账号无在线边缘时如实放弃（持久态由下次 hello 快照补）。 */
  pushPublishState(accountId: string, recordId: number, state: PublishUiState, title?: string | null): void {
    try {
      const edgeId = this.deps.resolveEdgeIdForAccount(accountId);
      if (!edgeId) {
        this.logger.log(`[ui-snapshot] ${state} 推送放弃：账号 ${accountId} 无在线边缘（recordId=${recordId}）`);
        return;
      }
      const payload: UiSnapshotPayload = {
        publish: { state, code: publishUiCode(recordId), ...(title ? { title } : {}) },
      };
      this.push(accountId, edgeId, payload, state);
    } catch (err) {
      this.logger.warn(
        `[ui-snapshot] ${state} 推送异常 account=${accountId} recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 将当前待审稿件预览定向推给绑定账号的在线边缘。 */
  pushPublishPreview(accountId: string, preview: UiPublishPreviewPayload): void {
    try {
      const edgeId = this.deps.resolveEdgeIdForAccount(accountId);
      if (!edgeId) {
        this.logger.log(`[ui-snapshot] 预览推送放弃：账号 ${accountId} 无在线边缘（recordId=${preview.recordId}）`);
        return;
      }
      this.push(accountId, edgeId, { publishPreview: preview }, 'publishPreview');
    } catch (err) {
      this.logger.warn(
        `[ui-snapshot] 预览推送异常 account=${accountId} recordId=${preview.recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async pushDailyUsageSnapshot(accountId: string, edgeId: string): Promise<void> {
    try {
      const [dailyUsage, browserStandby] = await Promise.all([
        this.deps.todayUsageForAccount ? this.deps.todayUsageForAccount(accountId, edgeId).catch(() => null) : Promise.resolve(null),
        this.deps.browserStandbyForAccount ? this.deps.browserStandbyForAccount(accountId, edgeId).catch(() => null) : Promise.resolve(null),
      ]);
      if (!dailyUsage && !browserStandby) {
        this.cancelDailyUsageRefresh(accountId, edgeId);
        return;
      }
      const payload: UiSnapshotPayload = {};
      if (dailyUsage) payload.dailyUsage = dailyUsage;
      if (browserStandby) payload.browserStandby = browserStandby;
      const sent = this.push(accountId, edgeId, payload, 'dailyUsage刷新');
      // 重排下一跳的条件是「推送成功 **且**（今日用量 **或** 待机提示 任一存在）」。
      // 旧条件只看今日用量 —— 待机提示还在、链却已死（change standby-covers-idle-waits）。
      if (sent > 0) this.scheduleSnapshotRefresh(accountId, edgeId, dailyUsage, Boolean(browserStandby));
      else this.cancelDailyUsageRefresh(accountId, edgeId);
    } catch (err) {
      this.cancelDailyUsageRefresh(accountId, edgeId);
      this.logger.warn(
        `[ui-snapshot] dailyUsage 刷新异常 account=${accountId} edge=${edgeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private push(accountId: string, edgeId: string, payload: UiSnapshotPayload, tag: string): number {
    const env = makeEnvelope('ui.snapshot', this.idGen(), this.clock(), payload);
    const sent = this.deps.pusher.pushToEdges(env, edgeId);
    if (sent <= 0) {
      this.logger.warn(`[ui-snapshot] ${tag} 推送未送达 account=${accountId} edge=${edgeId}（连接可能刚断，不重试）`);
    }
    return sent;
  }

  /**
   * 排下一跳快照刷新。
   *
   * **这条自己续自己的链是冷待机账号唯一的唤醒路径**（change standby-covers-idle-waits）：待机期间边缘的核心进程
   * 与云端连接不断，账号一旦恢复可工作，下一跳提示即 `eligible=false`，边缘据此唤醒浏览器。链一断，一个让出了
   * 槽位的账号就再也醒不过来——尤其是**冻结账号**，它压根没有「配额窗口将释放」这回事。
   *
   * 故链有待机提示在场时 MUST NOT 断。旧实现有两条断裂路径，都会静默把账号睡死：
   *  ① 今日用量为空 → 调用方直接 cancel（已在调用处修）；
   *  ② 今日用量在场、但没有任何窗口带着未来的刷新时刻 → 这里 `refreshAt === undefined` → 不排、链断。
   * 现在：待机提示在场时保底按 `STANDBY_REFRESH_INTERVAL_MS` 续跳；两者都在则取更早的那个。
   */
  private scheduleSnapshotRefresh(
    accountId: string,
    edgeId: string,
    dailyUsage: UiDailyUsagePayload | null,
    hasStandby: boolean,
  ): void {
    const now = this.clock();
    const usageAt = dailyUsage ? nextDailyUsageRefreshAt(dailyUsage, now) : undefined;
    const standbyAt = hasStandby ? now + STANDBY_REFRESH_INTERVAL_MS : undefined;
    const refreshAt = usageAt === undefined
      ? standbyAt
      : standbyAt === undefined ? usageAt : Math.min(usageAt, standbyAt);
    this.cancelDailyUsageRefresh(accountId, edgeId);
    if (refreshAt === undefined) return;
    const delay = Math.max(MIN_DAILY_USAGE_REFRESH_DELAY_MS, Math.ceil(refreshAt - this.clock()));
    const timer = this.setTimeoutFn(() => {
      this.dailyUsageTimers.delete(this.dailyUsageTimerKey(accountId, edgeId));
      void this.pushDailyUsageSnapshot(accountId, edgeId);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.dailyUsageTimers.set(this.dailyUsageTimerKey(accountId, edgeId), timer);
  }

  private cancelDailyUsageRefresh(accountId: string, edgeId: string): void {
    const key = this.dailyUsageTimerKey(accountId, edgeId);
    const existing = this.dailyUsageTimers.get(key);
    if (existing) this.clearTimeoutFn(existing);
    this.dailyUsageTimers.delete(key);
  }

  private dailyUsageTimerKey(accountId: string, edgeId: string): string {
    return `${accountId}\u0000${edgeId}`;
  }
}

function nextDailyUsageRefreshAt(dailyUsage: UiDailyUsagePayload, now: number): number | undefined {
  let next: number | undefined;
  for (const window of Object.values(dailyUsage.windows ?? {})) {
    const refreshAt = window?.refreshAt;
    if (typeof refreshAt !== 'number' || !Number.isFinite(refreshAt) || refreshAt <= now) continue;
    next = next === undefined ? refreshAt : Math.min(next, refreshAt);
  }
  return next;
}
