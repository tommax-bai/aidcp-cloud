/**
 * 引流线索评估角色（change feed-hot-lead-group-comment，段一）。
 *
 * 接在**稿件价值判定之后**：只对通过质量闸（`quality.pass`）的笔记评估热度。
 * 两事件按 noteId 对齐——
 *  - `note.detail.arrived`：缓存当前笔记的 noteId/likeCount/publishedAtText（浏览闭环一次一篇，缓存最近一篇）；
 *  - `quality.pass`：对放行 noteId 取缓存详情，跑纯确定性热度过滤闸，命中且未评过 → 入引流待评候选队列。
 * 被 `quality.reject`（含 LLM 出错/解析失败）的帖不入队——继承稿件价值判定的质量门槛。
 *
 * 纯确定性、不调 LLM（故不进 role-catalog）。回调 fire-and-forget、不阻塞浏览主路径。
 * 红线：只发现、不发布；发布时刻不可得/超窗一律不入队、不臆造。
 */
import { BaseRole, type RoleOptions } from '../agents/base-role.js';
import type { RoleName, NoteDetailData, QualityPassPayload } from '../event-bus/types.js';
import {
  evaluateHotLead,
  DEFAULT_HOT_LEAD_GATE_CONFIG,
  type HotLeadGateConfig,
} from './heat-velocity.js';
import type { HotLeadQueue } from './hot-lead-queue.js';

export interface HotLeadDetectorOptions extends RoleOptions {
  /** 候选队列存储（只发现不发布）。 */
  queue: HotLeadQueue;
  /** 当前连接的账号 id 取值口（热加载，仿 curated_note_evaluator）。 */
  getAccountId: () => string;
  /** 过滤闸阈值取值口（默认 DEFAULT_HOT_LEAD_GATE_CONFIG；组 4 接后台全局配置 provider）。 */
  getGateConfig?: () => HotLeadGateConfig;
  /** 「本账号已评过该笔记」去重口（接 riskStore.hasInteraction(accountId,noteId,'comment')）；缺则跳过该道去重。 */
  hasCommented?: (accountId: string, noteId: string) => Promise<boolean>;
}

export class HotLeadDetector extends BaseRole {
  readonly roleName: RoleName = 'hot_lead_detector';

  private readonly queue: HotLeadQueue;
  private readonly getAccountId: () => string;
  private readonly getGateConfig: () => HotLeadGateConfig;
  private readonly hasCommented?: (accountId: string, noteId: string) => Promise<boolean>;

  /** 最近一篇详情缓存（浏览闭环一次一篇）：quality.pass 到达时按 noteId 取用。 */
  private lastDetail: { detail: NoteDetailData; accountId?: string } | null = null;

  private unsubscribers: Array<() => void> = [];

  constructor(options: HotLeadDetectorOptions) {
    super(options);
    this.queue = options.queue;
    this.getAccountId = options.getAccountId;
    this.getGateConfig = options.getGateConfig ?? (() => DEFAULT_HOT_LEAD_GATE_CONFIG);
    this.hasCommented = options.hasCommented;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.detail.arrived', (p) => {
        // 只缓存正常详情（refreshOnly 图快照不参与）。
        if (p.detail?.refreshOnly) return;
        this.lastDetail = { detail: p.detail, accountId: p.accountId };
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
  }

  private async onQualityPass(payload: QualityPassPayload): Promise<void> {
    const cached = this.lastDetail;
    // 缓存 miss（无对应详情，或已被下一篇覆盖）：诚实跳过，不臆造。
    if (!cached || cached.detail.noteId !== payload.noteId) return;

    const detail = cached.detail;
    const accountId = cached.accountId ?? this.getAccountId();
    const config = this.getGateConfig();

    const evAl = evaluateHotLead(
      { likeCount: detail.likeCount, publishedAtText: detail.publishedAtText },
      config,
    );
    if (!evAl.isLead) return; // 非线索（超窗/赞不足/速率不足/时刻不可得）——只发现不发布，静默略过

    // 已评过去重（本账号）：接 riskStore.hasInteraction；缺该口则只靠队列内 pending 去重。
    if (this.hasCommented) {
      const seen = await this.hasCommented(accountId, detail.noteId).catch(() => false);
      if (seen) return;
    }

    const res = await this.queue.enqueue({
      accountId,
      noteId: detail.noteId,
      snapshot: {
        title: detail.title,
        likeCount: detail.likeCount,
        velocity: evAl.velocity ?? 0,
        ageHours: evAl.hoursAgo ?? 0,
      },
    });
    if (res.ok) {
      this.log(
        `引流线索入队 note=${detail.noteId} 赞=${detail.likeCount} 速率≈${Math.round(evAl.velocity ?? 0)}/h 帖龄≈${evAl.hoursAgo}h account=${accountId}`,
      );
    }
  }
}
