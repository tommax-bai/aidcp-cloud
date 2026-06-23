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

export class CommentDeAiFlavor extends BaseRole {
  readonly roleName: RoleName = 'comment_de_ai_flavor';
  private readonly post: PostProcessor;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions) {
    super(options);
    this.post = new PostProcessor(
      this.llm
        ? { rewrite: (content, flagged) => this.rewrite(content, flagged) }
        : {},
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
      const result = await this.post.process(payload.draft);
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

  /** 改写【一次】，让评论表达相近的体会但用自己的话，明确不照搬参考。 */
  private async rewriteAwayFrom(content: string, references: string[]): Promise<string> {
    const prompt = `下面这条评论与某些「参考评论」过于雷同，有照搬嫌疑。请用你自己的话重写，保持相近的体会与贴题，但句子结构与措辞要明显不同，不要复述参考。只输出重写后的评论本身：

参考评论（不可照抄）：
${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}

待重写评论：
${content}`;
    const raw = await this.decide(prompt);
    return raw.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim() || content;
  }

  /** 只读预览（change role-prompt-visibility）：复刻 rewrite（去 AI 味主路径）真实模板 + 示例数据，仅供后台查看；不改 rewrite/rewriteAwayFrom 逻辑。 */
  previewPrompt(): string {
    const content = '<示例评论正文，运行时为待改写评论>';
    const flagged = ['<命中套话示例>'];
    return `下面这条评论有 AI 腔/套话（命中：${flagged.join('、')}）。把它改写成更像真人随手留言的口吻，保持原意与长度、保持贴题，去掉套话与过量感叹号，不要出现 @ 与话题标签。只输出改写后的评论本身：
${content}`;
  }

  private async rewrite(content: string, flagged: string[]): Promise<string> {
    const prompt = `下面这条评论有 AI 腔/套话（命中：${flagged.join('、')}）。把它改写成更像真人随手留言的口吻，保持原意与长度、保持贴题，去掉套话与过量感叹号，不要出现 @ 与话题标签。只输出改写后的评论本身：
${content}`;
    const raw = await this.decide(prompt);
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
