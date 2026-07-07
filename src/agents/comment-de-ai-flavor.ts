/**
 * CommentDeAiFlavor — 评论去 AI 味角色（确定性，复用发帖侧 PostProcessor）。
 *
 * 职责：把撰写的评论草稿过一遍去 AI 味（禁用词扫描 + 命中超阈时至多一次重写）。
 * 消费事件：comment.composed
 * 产出事件：comment.cleared（终稿）或 comment.skipped（清洗后为空）
 *
 * 确定性、不抛异常：重写器仅在有 LLM 时启用；无 LLM 则仅扫描、原样透传（仍可单测）。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName, CommentComposedPayload } from '../event-bus/types.js';
import { PostProcessor } from '../publish-agent/post-processor.js';

/**
 * 评论体裁专用 AI 味信号集（change humanize-interaction-prompts）：发帖侧词表是长文议论文连接词，
 * 对评论近零召回；评论的 AI 腔主形态是**客套 / 敷衍 / 和稀泥**。命中 1 条即触发人设口吻改写。
 * 初版高精度、人工校准（宁少勿滥，避免误伤真诚口语；参 BANNED_PHRASES 里「不得不说」因是真人常用被移出的先例）。
 * 与发帖侧 BANNED_PHRASES 叠加，不改发帖侧行为。
 */
export const COMMENT_AI_PHRASES: string[] = [
  '感谢分享',
  '感谢楼主',
  '受益匪浅',
  '干货满满',
  '满满的干货',
  '涨知识了',
  '学到了很多',
  '说得太对了',
  '说到我心坎里',
  '深有同感',
  '不明觉厉',
  '期待你的更新',
  '支持一下',
  '值得收藏',
];

/** 评论触发改写的命中阈值（1 = 命中一条客套句即改写；发帖侧仍用默认 2）。 */
const COMMENT_REWRITE_THRESHOLD = 1;
/** 评论体裁语气偏活泼，感叹号上限放宽到 3（避免单个「！」把真诚口语误判为过量）。 */
const COMMENT_EXCLAMATION_MAX = 3;

export class CommentDeAiFlavor extends BaseRole {
  readonly roleName: RoleName = 'comment_de_ai_flavor';
  private readonly post: PostProcessor;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions) {
    super(options);
    this.post = new PostProcessor(
      this.llm
        ? { rewrite: (content, flagged) => this.rewrite(content, flagged), rewriteThreshold: COMMENT_REWRITE_THRESHOLD, extraPhrases: COMMENT_AI_PHRASES }
        : { rewriteThreshold: COMMENT_REWRITE_THRESHOLD, extraPhrases: COMMENT_AI_PHRASES },
    );
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('comment.composed', (p) => this.onComposed(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private async onComposed(payload: CommentComposedPayload): Promise<void> {
    let text = payload.draft;
    try {
      const result = await this.post.process(payload.draft, COMMENT_EXCLAMATION_MAX);
      text = result.content;
    } catch {
      // 去 AI 味失败不应阻断：退回原草稿（确定性、不抛）。
      text = payload.draft;
    }
    text = text.trim();
    if (!text) {
      this.emit('comment.skipped', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        actions: payload.actions,
        reason: 'cleaned_empty',
        ts: Date.now(),
      });
      return;
    }

    // 撞车护栏（comment-like-on-detail B）：若终稿与某条语料参考近似照搬，改写【一次】使其不同；
    // 仍撞则【弃发】（绝不发近似抄袭、绝不循环）。
    const references = payload.references ?? [];
    if (references.length && overlapsAny(text, references)) {
      if (this.llm) {
        try {
          text = (await this.rewriteAwayFrom(text, references)).trim();
        } catch {
          /* 改写失败 → 保留原 text，下面统一再判一次 */
        }
      }
      if (!text || overlapsAny(text, references)) {
        this.emit('comment.skipped', {
          noteId: payload.noteId,
          sourcePageType: payload.sourcePageType,
          actions: payload.actions,
          reason: 'overlaps_reference',
          ts: Date.now(),
        });
        return;
      }
    }

    this.emit('comment.cleared', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      text,
      ts: Date.now(),
    });
  }

  /** 改写【一次】，让评论表达相近的体会但用自己的话，明确不照搬参考。
   *  change humanize-interaction-prompts：撞车改写复用主路径人设口吻行——最需要账号间差异化的时刻，
   *  绝不收敛成无人设的通用中庸腔。 */
  private async rewriteAwayFrom(content: string, references: string[]): Promise<string> {
    const prompt = `下面这条评论与某些「参考评论」过于雷同，有照搬嫌疑。${this.personaVoiceLine()}，保持相近的体会与贴题，但句子结构与措辞要明显不同，不要复述参考。只输出重写后的评论本身：

参考评论（不可照抄）：
${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}

待重写评论：
${content}`;
    const raw = await this.decide(prompt);
    return raw.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim() || content;
  }

  /** 人设语气片段（change category-adaptive-images-and-judgment）：去 AI 味重写按该账号语气、不抹平成通用中庸腔。
   *  soul 未注入（如无账号预览）时诚实降级到通用口吻，不抛。 */
  private personaVoiceLine(): string {
    try {
      const { identity } = this.soul;
      return `把它按你（「${identity.name}」，${identity.role}，语气「${identity.tone}」）的口吻重写、保留你自己的个人腔`;
    } catch {
      return '把它改写成更像真人随手留言的口吻';
    }
  }

  /** 去 AI 味 rewrite 的共享模板（rewrite 与 previewPrompt 同源，守 prompt-preview 同源红线）。 */
  private buildRewritePrompt(content: string, flagged: string[]): string {
    return `下面这条评论有 AI 腔/套话（命中：${flagged.join('、')}）。${this.personaVoiceLine()}，保持原意、保持贴题，可以更短更随口（删减往往比堆砌更自然），去掉套话与明显模板腔（保留自然的口语感叹、只在明显套话时收敛），不要出现 @ 与话题标签。只输出改写后的评论本身：
${content}`;
  }

  /** 只读预览（change role-prompt-visibility）：复刻 rewrite（去 AI 味主路径）真实模板 + 示例数据，仅供后台查看；不改 rewrite/rewriteAwayFrom 逻辑。 */
  previewPrompt(): string {
    return this.buildRewritePrompt('<示例评论正文，运行时为待改写评论>', ['<命中套话示例>']);
  }

  private async rewrite(content: string, flagged: string[]): Promise<string> {
    const raw = await this.decide(this.buildRewritePrompt(content, flagged));
    return raw.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim() || content;
  }
}

// ─── 近似照搬判定（中英文通用，无 LLM）──────────────────────────────────────
/** 规范化：小写、仅留字母数字与 CJK。 */
function normForOverlap(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/** 字符 4-gram 集合。 */
function charNgrams(s: string, n = 4): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}

/** 两段文本是否近似照搬：4-gram Jaccard ≥ 0.5（太短不判）。 */
function nearVerbatim(a: string, b: string): boolean {
  const na = normForOverlap(a);
  const nb = normForOverlap(b);
  if (na.length < 6 || nb.length < 6) return false;
  const ga = charNgrams(na);
  const gb = charNgrams(nb);
  if (ga.size === 0 || gb.size === 0) return false;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/** 终稿是否与任一参考近似照搬。 */
export function overlapsAny(text: string, references: string[]): boolean {
  return references.some((r) => nearVerbatim(text, r));
}
