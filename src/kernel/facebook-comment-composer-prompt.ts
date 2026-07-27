import type { Soul, WritingLanguage } from './soul-types.js';
import { writingLanguageInstruction } from './writing-language.js';

export interface FacebookCommentComposerPromptInput {
  soul: Pick<Soul, 'identity'>;
  writingLanguage: WritingLanguage;
  keyword: string;
  postText?: string | null;
  comments?: string[];
  retry?: boolean;
}

/** Runtime and admin preview share this exact prompt builder to prevent drift. */
export function buildFacebookCommentComposerPrompt(input: FacebookCommentComposerPromptInput): string {
  const others = (input.comments ?? []).slice(0, 6).map((comment, index) => `${index + 1}. ${comment}`).join('\n');
  const hasBody = Boolean(input.postText && input.postText.trim());
  const contextLines = [
    hasBody ? `【帖子正文】\n${input.postText!.trim()}` : '【帖子正文】（这是一条图片/无文字正文的帖子）',
    others ? `【其他人的评论】\n${others}` : '【其他人的评论】（暂无可读评论）',
  ].join('\n\n');
  const keyword = input.keyword.trim();
  const keywordRule = keyword
    ? `- 与话题「${keyword}」相关，但不要生硬堆砌关键词；\n`
    : '';
  const prompt =
    `你在 Facebook 上以「${input.soul.identity.name}」（${input.soul.identity.role}）的身份，在下面这条帖子下写一条自然、真诚的评论。\n\n` +
    `${contextLines}\n\n` +
    '要求：\n' +
    `- **${writingLanguageInstruction(input.writingLanguage)}**；即使帖子或他人评论使用其他语言，也不要跟随切换；\n` +
    '- 顺着帖子和评论区的话茬自然回应，像真人随手留言，一两句即可；\n' +
    keywordRule +
    '- 不要外链、不要 @、不要联系方式（微信/电话/邮箱）、不要营销话术、不要话题标签；\n' +
    '- 只输出评论正文。';
  return input.retry
    ? `${prompt}\n\n上一次输出没有满足账号发言语言要求；这次必须纠正，只输出合法评论正文。`
    : prompt;
}
