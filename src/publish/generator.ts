/**
 * 内容生成器：调用 Qwen 基于素材生成一篇有人味的小红书帖子。
 *
 * 用 chat（system + user）而非单轮 complete，把人设/风格规则放 system，
 * 把本次素材放 user，便于模型稳定地学范文语气、避开 negative examples。
 *
 * 生成温度建议偏高（默认走注入的 chatModel 配置；本类不强制温度，由调用方在
 * 构造 QwenClient 时设置 temperature，例如 0.8 以增加"人味"随机性）。
 */

import type { QwenChatMessage } from '../llm/qwen.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildRewritePrompt,
  parseGenerateOutput,
} from './prompts.js';
import type { GenerateInput, GenerateOutput } from './types.js';

/** 支持多轮对话的模型客户端（QwenClient 即实现此接口）。 */
export interface ChatModel {
  chat(messages: QwenChatMessage[]): Promise<string>;
}

export interface ContentGeneratorOptions {
  model: ChatModel;
}

/** 内容生成器。 */
export class ContentGenerator {
  constructor(private readonly options: ContentGeneratorOptions) {}

  /** 基于素材生成一篇帖子。 */
  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const messages: QwenChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(input) },
    ];
    const raw = await this.options.model.chat(messages);
    return parseGenerateOutput(raw);
  }

  /**
   * 基于命中的禁用词重写一篇正文（去 AI 味第二轮）。
   * @param content 原正文
   * @param flaggedPhrases 命中的禁用词/句式
   */
  async rewrite(content: string, flaggedPhrases: string[]): Promise<GenerateOutput> {
    const messages: QwenChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildRewritePrompt(content, flaggedPhrases) },
    ];
    const raw = await this.options.model.chat(messages);
    return parseGenerateOutput(raw);
  }
}