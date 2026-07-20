/**
 * CommentAppraiser — 评论评估角色（LLM）。
 *
 * 职责：决定「要不要在这篇笔记发评论」（只判定、不产文本）。精品逻辑——只在高热度/高价值笔记上评。
 * 消费事件：interaction.completed（即仅在真 like/collect 过的笔记上触发）
 * 产出事件：comment.appraised（要评）或 comment.skipped（不评/无配额/无数据）
 *
 * 数量闸（最便宜阶段就拦）：会话评论预算 + 可选的每账号每日上限（min 取小，配置层下一阶段接入）。
 * mandatory 评论在编排前做一次只读风控预检，真正下发前 RoleDispatcher 仍保留最终风控闸。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import { tieredInterests } from './persona-format.js';
import { interactionLabel } from './interaction-label.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/registry.js';
import type { RoleName, InteractionCompletedPayload } from '../event-bus/types.js';

/**
 * 评论硬数值阈值（engagement-restraint；change category-adaptive-images-and-judgment 起收藏侧不再一刀切绝对值）：
 * 精品门槛 = 点赞 > COMMENT_MIN_LIKES **且**（收藏 > COMMENT_MIN_COLLECTS **或** 点赞 > COMMENT_HIGH_LIKES）。
 * 即超高热度爆帖（点赞极高）即便收藏绝对值不高也可达门槛——治「高赞低藏的情感 / 颜值爆帖被固定收藏一律排除」；
 * 但主条件仍要求较高点赞（非宽松纯 OR），保持 pre-LLM 便宜确定性门槛、必要非充分。达门槛后仍叠加 LLM 精品判定 + 飞书人审 + 每日上限 + 风控取小。
 *
 * change humanize-interaction-prompts：默认地板从 1000/300 下调到 300/100（等比），把中腰部高收藏内容
 * （教程 / 攻略 / 清单类）纳入候选；合取结构与超高热豁免（10000，不变）保持。门槛机制不变、仅调默认数值。
 */
export const COMMENT_MIN_LIKES = 300;
export const COMMENT_MIN_COLLECTS = 100;
/** 超高热度豁免收藏绝对值的点赞线（爆帖赞高藏低仍可达门槛）。 */
export const COMMENT_HIGH_LIKES = 10000;

export interface CommentAppraiserOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  /** 剩余会话评论预算（每会话稀缺名额）。 */
  getRemainingComments: () => number;
  /** 可选：该账号当日剩余评论上限（后台配置；缺省视为不额外限制，仅会话预算 + 风控生效）。 */
  getDailyRemaining?: () => number;
  /**
   * 评论冷却是否已过（engagement-restraint）；缺省视为不冷却（向后兼容）。
   * 由 dispatcher 接 `cooldownGate.canAct(currentAccountId, 'comment', clock())`——评论冷却前置到评估阶段，
   * 未到点直接 skip，避免白走撰写 / 去 AI 味 / 飞书人审。
   */
  getCommentCooldownOk?: () => boolean;
  /** mandatory 评论编排前的只读风控预检；缺省放行以兼容旧装配。 */
  getMandatoryRiskDecision?: () => { allowed: boolean; reason?: string; retryAfterMs?: number };
  /** 平台词汇 profile（change platform-vocabulary-and-thresholds）；缺省小红书 = 今天。用于站点名/内容名词/
   *  指标名词去硬编码 + 门槛平台化（无收藏概念平台放宽收藏合取支）。 */
  platformProfile?: CommentPlatformProfile;
  /** 总评论子链超时后拦截迟到异步结果。 */
  isCommentSublineExpired?: (noteId: string) => boolean;
}

export class CommentAppraiser extends BaseRole {
  readonly roleName: RoleName = 'comment_appraiser';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getRemainingComments: () => number;
  private readonly getDailyRemaining?: () => number;
  private readonly getCommentCooldownOk?: () => boolean;
  private readonly getMandatoryRiskDecision?: () => { allowed: boolean; reason?: string; retryAfterMs?: number };
  private readonly platformProfile: CommentPlatformProfile;
  private readonly isCommentSublineExpired: (noteId: string) => boolean;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentAppraiserOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentAppraiser 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.getRemainingComments = options.getRemainingComments;
    this.getDailyRemaining = options.getDailyRemaining;
    this.getCommentCooldownOk = options.getCommentCooldownOk;
    this.getMandatoryRiskDecision = options.getMandatoryRiskDecision;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.isCommentSublineExpired = options.isCommentSublineExpired ?? (() => false);
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('interaction.completed', (p) => this.onInteractionCompleted(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private skip(payload: InteractionCompletedPayload, reason: string): void {
    if (this.isCommentSublineExpired(payload.noteId)) return;
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
      ts: Date.now(),
    });
  }

  private async onInteractionCompleted(payload: InteractionCompletedPayload): Promise<void> {
    if (this.isCommentSublineExpired(payload.noteId)) return;
    const mandatory = payload.mandatoryInteraction;
    if (mandatory?.actions.includes('comment')) {
      const note = this.getNoteData(payload.noteId);
      if (!note) {
        this.skip(payload, 'note_data_unavailable');
        return;
      }
      // 显式结构化规则命中：跳过普通会话/日预闸、冷却、热度与“要不要评”LLM；但在昂贵的
      // 撰写 / 去 AI 味 / 飞书预授权卡之前先读一次最终风控同源判定。这里不做配额预占，真正
      // 下发前 dispatcher 仍会二次判定，覆盖预检与执行之间状态变化。
      const risk = this.getMandatoryRiskDecision?.();
      if (risk && !risk.allowed) {
        const reason = risk.reason ?? 'risk_blocked';
        this.log(
          `mandatory_preflight skip reason=${reason} note=${payload.noteId}` +
            (typeof risk.retryAfterMs === 'number' ? ` retryAfterMs=${risk.retryAfterMs}` : ''),
        );
        // 与 comment.appraised 同样排到微任务：dispatcher 的同级 interaction.completed 订阅
        // 先把本条 mandatory like 发出，再让评论支线诚实收敛。
        queueMicrotask(() => this.skip(payload, `risk_preflight:${reason}`));
        return;
      }
      this.log(`mandatory_match rule=${mandatory.ruleId} → force comment compose`);
      // 与下方普通评论的 comment.appraising 一样排到微任务：本角色比 dispatcher 的
      // interaction.completed 指令翻译更早订阅；若同步 emit，comment.appraised 会先把
      // commentInflight 置真，导致同一 mandatory 规则的 like 尚未下发就被钉页闸吞掉。
      queueMicrotask(() => {
        if (this.isCommentSublineExpired(payload.noteId)) return;
        this.emit('comment.appraised', {
          noteId: payload.noteId,
          sourcePageType: payload.sourcePageType,
          actions: payload.actions,
          reason: `mandatory_rule:${mandatory.ruleId}`,
          mandatoryInteraction: mandatory,
          ts: Date.now(),
        });
      });
      return;
    }
    // 数量闸（最便宜阶段）：会话预算 + 每日上限取小，任一耗尽即不评。
    if (this.getRemainingComments() <= 0) {
      this.skip(payload, 'no_comment_budget');
      return;
    }
    if (this.getDailyRemaining && this.getDailyRemaining() <= 0) {
      this.skip(payload, 'daily_cap_reached');
      return;
    }
    // 评论冷却（engagement-restraint）：前置到评估阶段，未到点直接跳过，绝不进入撰写 / 去 AI 味 / 人审。
    if (this.getCommentCooldownOk && !this.getCommentCooldownOk()) {
      this.skip(payload, 'cooldown');
      return;
    }

    const note = this.getNoteData(payload.noteId);
    if (!note) {
      this.skip(payload, 'note_data_unavailable');
      return;
    }
    // 硬数值阈值（engagement-restraint）：主条件 = 点赞 > MIN_LIKES（**恒保留**，绝不退化为无门槛）。
    // 收藏合取支平台化（change platform-vocabulary-and-thresholds）：有收藏概念的平台（小红书）仍需
    // 收藏 > MIN_COLLECTS 或 点赞 > HIGH_LIKES 的高热豁免；**无收藏概念的平台**（Facebook：metrics.collect==='' 且
    // collectCount 恒 0）放宽收藏合取支为 true（否则 collectOk 退化成只认 >10000 赞、正常热度帖恒不评=旧 bug）。
    const hasCollect = this.platformProfile.metrics.collect !== '';
    const collectOk = !hasCollect || note.collectCount > COMMENT_MIN_COLLECTS || note.likeCount > COMMENT_HIGH_LIKES;
    if (!(note.likeCount > COMMENT_MIN_LIKES && collectOk)) {
      this.skip(payload, 'below_comment_threshold');
      return;
    }

    // 评论支线在途起点·前移一格（change comment-approval-target-hold）：便宜阈值全过、即将调 LLM 判定值不值得评。
    // dispatcher 据此提前把账号钉在待评论帖上，覆盖 appraiser-LLM 这段（否则并行点赞 no_target 重扫会把目标帖滚走）。
    // 未过阈者已在上面同步 skip、不到这里 ⇒ 不置在途标志、不过度抑制正常浏览。由既有 comment.skipped/approved 清位。
    // **必须排到微任务**：本角色订阅早于 dispatcher，若同步 emit，dispatcher 的 comment.appraising 处理器会先于它自己的
    // interaction.completed 处理器把 commentInflight 置真 → 把**本次**待发的 like/collect 命令一并扣住（回归：路径F collect 丢失）。
    // 微任务把置位排到本次同步 emit 之后（届时 like/collect 已下发），仍远早于点赞回执的边缘往返 ⇒ 覆盖 appraiser 窗、不误伤互动下发。
    queueMicrotask(() => {
      if (this.isCommentSublineExpired(payload.noteId)) return;
      this.emit('comment.appraising', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        actions: payload.actions,
        ts: Date.now(),
      });
    });

    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note, payload.actions));
    } catch {
      if (this.isCommentSublineExpired(payload.noteId)) return;
      this.skip(payload, 'llm_error');
      return;
    }
    if (this.isCommentSublineExpired(payload.noteId)) return;

    const verdict = this.parseOutput(raw);
    if (!verdict) {
      this.skip(payload, 'parse_failed');
      return;
    }
    if (!verdict.comment) {
      this.skip(payload, verdict.reason || 'not_worth_commenting');
      return;
    }

    if (this.isCommentSublineExpired(payload.noteId)) return;
    this.emit('comment.appraised', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      // 穿透「为何值得评」的理由给撰写角色（change humanize-interaction-prompts）：撰写不必从零重推切入点。
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ts: Date.now(),
    });
  }

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, ['like']);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    return [this.personaHeader()];
  }

  /** 人设头（change humanize-interaction-prompts）：注入身份 / 背景 / 语气 / 兴趣 / 浏览风格，
   *  让「开不开口评论」这种性格行为随账号不同而不同（不再只有名字+职业+兴趣）。 */
  private personaHeader(): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const lines = [`你是「${identity.name}」，${identity.role}。${identity.background}`, `语气：${identity.tone}`, `兴趣：${tieredInterests(interests)}`];
    if (bg?.style) lines.push(`你平时逛${this.platformProfile.siteName}的风格：${bg.style}`);
    return lines.join('\n');
  }

  private buildPrompt(note: NoteData, actions: ('like' | 'collect')[] = []): string {
    const p = this.platformProfile;
    // 指标行：无收藏概念平台（收藏名词为空）只渲染点赞，绝不显示误导的「收藏：0」。
    const metricsLine = `${p.metrics.like}数：${note.likeCount}${p.metrics.collect ? `，${p.metrics.collect}数：${note.collectCount}` : ''}`;
    return `${this.personaHeader()}

你刚${interactionLabel(actions)}这篇${p.contentName}，现在在想「要不要在下面留一条评论」。

评论是你最慎重的互动——多数时候你只看不评，只在真有话想说、且内容够好时才开口。
你什么时候会评：
- 这篇确实是被很多人认可的好内容（热度明显偏高）；
- 你对它真有共鸣、有具体的话能说，能自然接上一句；
- 反过来：普通 / 冷清的${p.contentName}、你其实没真东西可说、只能说「学到了 / 感谢分享」这类客套的，一律不评。

当前${p.contentName}：
标题：${note.title}
内容：${note.content}
${metricsLine}

只输出JSON：
要评：{"comment":true,"reason":"你真正想说的那句话的由头"}
不评：{"comment":false,"reason":"简短原因"}`;
  }

  private parseOutput(raw: string): { comment: boolean; reason: string } | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.comment !== 'boolean') return null;
    const reason = typeof o.reason === 'string' ? o.reason : '';
    return { comment: o.comment, reason };
  }
}
