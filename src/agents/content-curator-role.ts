/**
 * ContentCuratorRole — 详情页内容质量粗筛角色（LLM，事件驱动版）。
 *
 * 职责：评估笔记内容质量，判断是否值得深度阅读。
 * 消费事件：note.detail.arrived（Edge 上报笔记详情后触发）
 * 产出事件：quality.pass（质量好）或 quality.reject（质量差）
 *
 * 相比旧版的改进：
 * - 监听 note.detail.arrived 而非 note.entered，确保有实际数据可评估
 * - 直接使用 payload 中的笔记数据，无需外部 getNoteData 回调
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/registry.js';
import type { Soul } from '../kernel/soul-types.js';
import type { MandatoryInteractionContext } from '../event-bus/types.js';
import { mandatoryInteractionContext, mandatoryInteractionPrompt } from './mandatory-interaction.js';
import type { NoteData } from '../kernel/note-detail.js';

// NoteData 纯数据模型抬入 kernel（change decouple-longtail-sweep）供 content 侧评估角色跨边界共导；
// 本文件等值再导出，令 automation 侧既有消费方无感。
export type { NoteData };

export interface ContentCuratorRoleOptions extends RoleOptions {
  sessionContext: SessionContext;
  /** 平台词表（站名/内容名/指标）：dispatcher 经 commonOptions 注入，缺省回落小红书。 */
  platformProfile?: CommentPlatformProfile;
  /** 规则模式等非人设读链可关闭本角色；关闭时不得读取 Soul 或调用 LLM。 */
  shouldEvaluate?: () => boolean;
}

export class ContentCuratorRole extends BaseRole {
  readonly roleName: RoleName = 'content_curator';
  private readonly sessionContext: SessionContext;
  private readonly platformProfile: CommentPlatformProfile;
  private readonly shouldEvaluate: () => boolean;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ContentCuratorRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('ContentCuratorRole 需要 LlmClient');
    this.sessionContext = options.sessionContext;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.shouldEvaluate = options.shouldEvaluate ?? (() => true);
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.detail.arrived', (p) => this.onNoteDetailArrived(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onNoteDetailArrived(payload: { detail: NoteData; ts: number }): Promise<void> {
    if (!this.shouldEvaluate()) return;
    const noteData = payload.detail;
    const sourcePageType = this.sessionContext.sourcePageType;
    // 一次判定固定一份人设快照，避免 LLM 在途期间热更新导致 prompt 与 rule-id 校验来自两版配置。
    const soul = this.soul;

    const prompt = this.buildPrompt(noteData, soul);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw, soul);
    if (!result) {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.action === 'pass') {
      this.emit('quality.pass', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: result.reason,
        ...(result.mandatoryInteraction ? { mandatoryInteraction: result.mandatoryInteraction } : {}),
        ts: Date.now(),
      });
    } else {
      this.emit('quality.reject', {
        noteId: noteData.noteId,
        sourcePageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, this.soul);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const mandatory = mandatoryInteractionPrompt(this.soul);
    return [
      `你是「${identity.name}」，${identity.role}。\n你的兴趣：${interestsStr}`,
      ...(mandatory ? [`账号显式强制互动规则：\n${mandatory}`] : []),
    ];
  }

  private buildPrompt(note: NoteData, soul: Soul): string {
    const { identity, interests } = soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const mandatory = mandatoryInteractionPrompt(soul);
    const mandatoryBlock = mandatory
      ? `\n\n账号显式强制互动规则：\n${mandatory}\n判断优先级：\n- 用当前详情全文确认规则是否命中；命中时必须 action=pass，并把精确 id 写入 mandatoryRuleId，后续动作不再由普通互动模型否决。\n- 强制规则绝不覆盖全局品牌安全：政治敏感、色情低俗、赌博、违法或明显不良导向仍必须 close_note，且不得返回 mandatoryRuleId。\n- 未命中规则时不要输出 mandatoryRuleId，继续按下面普通粗筛口径判断。`
      : '';

    return `你是「${identity.name}」，${identity.role}。
你的兴趣：${interestsStr}${mandatoryBlock}
你在快速判断：这篇${this.platformProfile.siteName}${this.platformProfile.contentName}**要不要继续看**（不是评内容好坏，只是粗筛）。

${this.platformProfile.contentName}信息：
标题：${note.title}
内容：${note.content}
作者：${note.author ?? '未知'}
${this.platformProfile.metrics.like}：${note.likeCount}${this.platformProfile.metrics.collect ? `，${this.platformProfile.metrics.collect}：${note.collectCount}` : ''}

判断口径（偏挑剔，只放真正相关且有内容的）：
- 只有**话题与你的兴趣明显相关、且${this.platformProfile.contentName}真有信息 / 观点 / 经验**时才 pass。
- 这几类一律 close_note：纯广告/带货导流、通篇空话毫无信息、只蹭热点的标题党、与你的兴趣只是擦边或完全无关、纯情绪宣泄无实质内容。
- **正文为空或很短不等于质量差**：可能是图文/视频${this.platformProfile.contentName}，正文本就少；不要仅因正文短而 close（仍按话题相关度与信息量判断）。
- **拿不准时倾向 close**，宁缺毋滥——把宝贵的互动额度留给真正相关有价值的${this.platformProfile.contentName}。

只输出JSON：${mandatory ? '{"action":"pass","mandatoryRuleId":"命中的精确规则id","reason":"简短原因"}\n或（普通通过）：' : ''}{"action":"pass","reason":"简短原因","confidence":0.7}
或（关闭）：{"action":"close_note","reason":"简短原因","confidence":0.7}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string, soul: Soul): CuratorResult | null {
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

    const validActions = new Set(['close_note', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return null;
    }

    const action = o.action as 'close_note' | 'pass';
    const reason = typeof o.reason === 'string' ? o.reason : 'content_evaluated';
    const mandatoryRuleId = typeof o.mandatoryRuleId === 'string' ? o.mandatoryRuleId : undefined;
    const mandatory = mandatoryInteractionContext(soul, mandatoryRuleId);
    // 模型声称命中但 id 不在当前人设、或一边 close 一边声称强制命中 → fail-closed。
    if (mandatoryRuleId && !mandatory) return null;
    if (mandatory && action !== 'pass') return null;

    return { action, reason, ...(mandatory ? { mandatoryInteraction: mandatory } : {}) };
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface CuratorResult {
  action: 'close_note' | 'pass';
  reason: string;
  mandatoryInteraction?: MandatoryInteractionContext;
}
