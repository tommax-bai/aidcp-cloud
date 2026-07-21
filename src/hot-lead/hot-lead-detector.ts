/**
 * 引流线索评估角色（change feed-hot-lead-group-comment → feed-hot-lead-auto-group-comment）。
 *
 * 接在**稿件价值判定之后**：只对通过质量闸（`quality.pass`）的笔记评估热度（两事件按 noteId 对齐，
 * `note.detail.arrived` 缓存最近一篇、`quality.pass` 放行才跑闸）。命中且过安全闸 → **经受闸自动评论 helper
 * 触发一条带联系方式的引流评论**（复用当前 note.detail → 飞书人审=发），不再入持久队列。
 *
 * 统一安全模型（change feed-hot-lead-auto-group-comment）：与普通评论共用评论安全上限——
 *  - 场次：单场会话评论预算（此处 gate + 触发成功即扣减）；
 *  - 时/日 + 子上限 + 记账：由注入的 `fireAutoContactComment` 统一处置；任务触发只记尝试，
 *    真正发出后才消费共用 comment 配额。
 * 去重三层：`hasCommented`（已发出）+ 本角色**短时 triggered 标记**（防人审拒/超时后重刷反复推审）+ 触发通道单飞。
 *
 * 纯确定性、不调 LLM（不进 role-catalog）。回调 fire-and-forget、不阻塞浏览。账号未开自动联系评论 → 仅记日志、不发（零回归）。
 */
import { BaseRole, type RoleOptions } from '../agents/base-role.js';
import type { RoleName, NoteDetailData, QualityPassPayload } from '../event-bus/types.js';
import {
  evaluateHotLead,
  DEFAULT_HOT_LEAD_GATE_CONFIG,
  type HotLeadGateConfig,
} from './heat-velocity.js';

export interface FireAutoContactArgs {
  accountId: string;
  noteId: string;
  title: string;
  /** 刚刚被质量闸判定通过的当前详情；自动联系评论必须复用它，不按标题搜索兜底。 */
  currentDetail: NoteDetailData;
  velocity: number;
  ageHours: number;
}

export interface HotLeadDetectorOptions extends RoleOptions {
  getAccountId: () => string;
  /** 过滤闸阈值取值口（默认保守常量；接后台全局配置 provider）。 */
  getGateConfig?: () => HotLeadGateConfig;
  /** 账号是否开启自动联系评论（`contactCommentEnabled`）；缺则视为未开（不发，零回归）。 */
  isAutoContactEnabled?: (accountId: string) => Promise<boolean>;
  /** 「本账号已评过该笔记」去重口（接 riskStore.hasInteraction(accountId,noteId,'comment')）。 */
  hasCommented?: (accountId: string, noteId: string) => Promise<boolean>;
  /** 触发一条受闸自动联系评论（内部走 helper：canDo+子上限+当前详情直评）。缺则仅记日志、不发。 */
  fireAutoContactComment?: (args: FireAutoContactArgs) => Promise<{ fired: boolean; reason?: string }>;
  /** 场次：当前会话剩余评论预算（缺则不设场次闸）。 */
  getSessionCommentBudgetRemaining?: () => number;
  /** 场次消耗：触发成功后扣减一次会话评论预算。 */
  consumeSessionCommentBudget?: () => void;
  /** triggered 标记 TTL（毫秒，默认 45min）；被拒/超时的帖此窗口内不再重触发。 */
  triggeredTtlMs?: number;
  /** 时钟（测试可注入）。 */
  now?: () => number;
}

const DEFAULT_TRIGGERED_TTL_MS = 45 * 60 * 1000;

export class HotLeadDetector extends BaseRole {
  readonly roleName: RoleName = 'hot_lead_detector';

  private readonly getAccountId: () => string;
  private readonly getGateConfig: () => HotLeadGateConfig;
  private readonly isAutoContactEnabled?: (accountId: string) => Promise<boolean>;
  private readonly hasCommented?: (accountId: string, noteId: string) => Promise<boolean>;
  private readonly fireAutoContactComment?: (args: FireAutoContactArgs) => Promise<{ fired: boolean; reason?: string }>;
  private readonly getSessionCommentBudgetRemaining?: () => number;
  private readonly consumeSessionCommentBudget?: () => void;
  private readonly triggeredTtlMs: number;
  private readonly now: () => number;

  private lastDetail: { detail: NoteDetailData; accountId?: string; observedAt: number } | null = null;
  /** 短时「本 note 已尝试过（任意终态）」标记：account:noteId → 过期时刻。 */
  private readonly triggeredMarks = new Map<string, number>();
  private unsubscribers: Array<() => void> = [];

  constructor(options: HotLeadDetectorOptions) {
    super(options);
    this.getAccountId = options.getAccountId;
    this.getGateConfig = options.getGateConfig ?? (() => DEFAULT_HOT_LEAD_GATE_CONFIG);
    this.isAutoContactEnabled = options.isAutoContactEnabled;
    this.hasCommented = options.hasCommented;
    this.fireAutoContactComment = options.fireAutoContactComment;
    this.getSessionCommentBudgetRemaining = options.getSessionCommentBudgetRemaining;
    this.consumeSessionCommentBudget = options.consumeSessionCommentBudget;
    this.triggeredTtlMs = options.triggeredTtlMs ?? DEFAULT_TRIGGERED_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.detail.arrived', (p) => {
        if (p.detail?.refreshOnly) return;
        this.lastDetail = { detail: p.detail, accountId: p.accountId, observedAt: p.ts };
      }),
      this.eventBus.on('quality.pass', (p) => {
        void this.onQualityPass(p);
      }),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.lastDetail = null;
    this.triggeredMarks.clear();
  }

  private markKey(accountId: string, noteId: string): string {
    return `${accountId}:${noteId}`;
  }

  private recentlyTriggered(key: string): boolean {
    const exp = this.triggeredMarks.get(key);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.triggeredMarks.delete(key);
      return false;
    }
    return true;
  }

  private async onQualityPass(payload: QualityPassPayload): Promise<void> {
    const cached = this.lastDetail;
    if (!cached || cached.detail.noteId !== payload.noteId) return; // 缓存 miss：诚实跳过

    const detail = cached.detail;
    const accountId = cached.accountId ?? this.getAccountId();

    const evAl = evaluateHotLead(
      { likeCount: detail.likeCount, publishedAtText: detail.publishedAtText, observedAt: cached.observedAt },
      this.getGateConfig(),
    );
    if (!evAl.isLead) return; // 非热帖线索：静默略过

    // 账号未开自动联系评论 → 仅记日志、不发（零回归）。
    const enabled = this.isAutoContactEnabled ? await this.isAutoContactEnabled(accountId).catch(() => false) : false;
    if (!enabled) {
      this.log(`引流线索命中(未开自动联系评论,不发) note=${detail.noteId} 速率≈${Math.round(evAl.velocity ?? 0)}/h account=${accountId}`);
      return;
    }
    if (!this.fireAutoContactComment) return; // 依赖未接线：安全退化，不发

    // 去重：已评过 / 短时已尝试。
    if (this.hasCommented && (await this.hasCommented(accountId, detail.noteId).catch(() => false))) return;
    const key = this.markKey(accountId, detail.noteId);
    if (this.recentlyTriggered(key)) return;

    // 场次闸：单场评论预算耗尽 → 不触发。
    if (this.getSessionCommentBudgetRemaining && !(this.getSessionCommentBudgetRemaining() > 0)) return;

    // 置短时 triggered 标记（触发前置位，防并发/重刷重复触发；任意终态都占窗口）。
    this.triggeredMarks.set(key, this.now() + this.triggeredTtlMs);

    const res = await this.fireAutoContactComment({
      accountId,
      noteId: detail.noteId,
      title: detail.title,
      currentDetail: detail,
      velocity: evAl.velocity ?? 0,
      ageHours: evAl.hoursAgo ?? 0,
    }).catch((e) => ({ fired: false, reason: (e as Error).message }));

    if (res.fired) {
      this.consumeSessionCommentBudget?.(); // 场次消耗（与普通评论共用预算）
      this.log(`引流线索自动联系评论已触发(飞书审批) note=${detail.noteId} 速率≈${Math.round(evAl.velocity ?? 0)}/h account=${accountId}`);
    } else {
      this.log(`引流线索命中但未触发(${res.reason}) note=${detail.noteId} account=${accountId}`);
    }
  }
}
