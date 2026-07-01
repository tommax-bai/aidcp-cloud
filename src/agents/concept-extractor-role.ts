/**
 * ConceptExtractorRole — 从浏览内容中抽取领域/话题概念关键词（LLM，事件驱动）。
 *
 * 职责：浏览到笔记详情时，用 LLM 从 title+content 抽取 1-3 个高置信领域/话题概念关键词（话题中立、不限技术领域），
 * 写入 ConceptStore（status='candidate'），使搜索关键词跨会话从浏览中学习，
 * 不再局限于 soul.yaml 的 6 个写死种子词。
 *
 * 消费事件：note.detail.arrived
 * 产出：旁路写入 ConceptStore（fire-and-forget，不阻塞浏览主闭环）
 *
 * 红线（MUST NOT 静默假成功）：抽不到关键词时不写任何行、不编造占位词。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteDetailData, RoleName } from '../event-bus/types.js';

/** 概念写入下游（ConceptStore 的最小契约，便于注入桩单测）。 */
export interface ConceptSink {
  addCandidate(keyword: string, sourceNote?: string): Promise<boolean>;
}

export interface ConceptExtractorRoleOptions extends RoleOptions {
  conceptStore: ConceptSink;
  /** 每篇笔记最多抽取的关键词数（默认 3）。 */
  maxKeywords?: number;
}

export class ConceptExtractorRole extends BaseRole {
  readonly roleName: RoleName = 'concept_extractor';
  private readonly conceptStore: ConceptSink;
  private readonly maxKeywords: number;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ConceptExtractorRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('ConceptExtractorRole 需要 LlmClient');
    this.conceptStore = options.conceptStore;
    this.maxKeywords = options.maxKeywords ?? 3;
  }

  subscribe(): void {
    this.unsubscribers.push(
      // 旁路消费：抽取不进浏览主链路的 await，fire-and-forget（异常自吞，记 warn）。
      this.eventBus.on('note.detail.arrived', (p) => {
        void this.onNoteDetailArrived(p);
      }),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onNoteDetailArrived(payload: { detail: NoteDetailData; ts: number }): Promise<void> {
    const note = payload.detail;
    // 标题与正文都为空 → 无可抽取来源，直接返回（不写库）。
    if (!note.title?.trim() && !note.content?.trim()) return;

    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note));
    } catch {
      // LLM 异常：不写库、不阻塞主闭环（红线：不编造）。
      return;
    }

    const keywords = this.parseKeywords(raw);
    // 红线：抽不到关键词 → 不写任何行、不产生占位/编造关键词。
    if (keywords.length === 0) {
      this.log(`无可抽取的概念，跳过写库 note="${oneLine(note.title)}"`);
      return;
    }

    for (const kw of keywords) {
      try {
        const inserted = await this.conceptStore.addCandidate(kw, note.title || undefined);
        if (inserted) this.log(`新概念入库 → "${kw}"（来源："${oneLine(note.title)}"）`);
      } catch (err) {
        this.log(`addCandidate 失败 keyword="${kw}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文>', author: '<示例作者>', authorId: '<示例authorId>', likeCount: 0, collectCount: 0 });
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。`, `你的兴趣领域：${interestsStr}`];
  }

  private buildPrompt(note: NoteDetailData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。
你在阅读一篇小红书笔记，请从中抽取**可用作搜索关键词的领域/话题概念名词**，用于后续主动检索同领域优质内容。

你的兴趣领域：${interestsStr}

笔记标题：${note.title}
笔记正文：${note.content}

抽取要求：
- 抽**具体的领域/话题概念名词**（可作搜索词，依笔记所属领域而定——如工具、方法、地点、品类、菜式、玩法等），不限技术领域。
- 与你兴趣领域相关、有检索价值的优先。
- 最多 ${this.maxKeywords} 个，按价值排序；宁缺毋滥。
- **如果笔记里没有值得检索的概念（如纯情绪宣泄/广告/无信息），返回空数组 []。不要编造、不要凑数。**

只输出 JSON 数组（不要输出其他内容）：
["概念1","概念2"]
或（无可抽取时）：[]`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  /** 解析 LLM 输出为关键词数组；解析失败或无有效项返回 []（不编造）。 */
  private parseKeywords(raw: string): string[] {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end <= start) return [];

    let arr: unknown;
    try {
      arr = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!Array.isArray(arr)) return [];

    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      const kw = item.trim();
      if (!kw) continue;
      const key = kw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(kw);
      if (out.length >= this.maxKeywords) break;
    }
    return out;
  }
}

/** 把多行文本压成单行并截断，用于日志预览。 */
function oneLine(s: string, max = 40): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
