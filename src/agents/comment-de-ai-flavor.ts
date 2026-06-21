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
    this.emit('comment.cleared', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      text,
      ts: Date.now(),
    });
  }

  private async rewrite(content: string, flagged: string[]): Promise<string> {
    const prompt = `下面这条评论有 AI 腔/套话（命中：${flagged.join('、')}）。把它改写成更像真人随手留言的口吻，保持原意与长度、保持贴题，去掉套话与过量感叹号，不要出现 @ 与话题标签。只输出改写后的评论本身：
${content}`;
    const raw = await this.decide(prompt);
    return raw.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim() || content;
  }
}
