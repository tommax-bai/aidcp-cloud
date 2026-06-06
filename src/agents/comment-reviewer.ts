/**
 * CommentReviewer — 评论区质量审查 Agent（LLM）。
 *
 * 职责：
 * - 分析笔记评论区 top 评论，辅助调整互动决策的 confidence
 * - 当前协议中评论字段暂未传递，shouldActivate 默认返回 false
 * - 预留框架，待协议补充评论数据后启用
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import { BaseAgent } from './types.js';
import type { BaseAgentOptions } from './types.js';

export class CommentReviewer extends BaseAgent {
  readonly role: AgentRole = 'comment_reviewer';

  constructor(options: BaseAgentOptions) {
    super(options);
  }

  /**
   * 当前协议中评论字段暂未传递，默认不激活。
   * 待黑板扩展 comments 字段后可改为检测评论数据是否存在。
   */
  shouldActivate(_board: BlackboardState): boolean {
    // 当前黑板无评论字段，始终不激活
    return false;
  }

  async decide(_board: BlackboardState): Promise<AgentDecision> {
    // 框架预留：有评论时评估 top 评论质量，修正 confidence
    return this.pass('comment_data_unavailable');
  }
}
