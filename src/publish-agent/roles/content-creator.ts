import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ScoutDecision, TriggerInput, CreatedContent } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildCreatorPrompt } from '../prompts.js';
import { escapeControlCharsInJsonStrings } from '../json-repair.js';
import { executeWithRetry } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';
import { checkWritingLanguage } from '../../kernel/writing-language.js';

// 内容生成超时（角色闸 + LLM 调用同值）：放宽到 120s，容纳较强/较慢模型（如 qwen-max 系）。env 可调。
const CONTENT_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_CONTENT_TIMEOUT_MS ?? 180_000);

export interface ContentCreatorDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface CreatorInput {
  scoutDecision: ScoutDecision;
  trigger: TriggerInput;
}

export class ContentCreatorRole extends BasePublishRole<CreatorInput, CreatedContent> {
  readonly config: RoleConfig = {
    name: 'ContentCreator',
    watchKeys: ['scoutDecision'],
    timeoutMs: CONTENT_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'createdContent' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: ContentCreatorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return !snapshot.trigger?.generateInput.referenceNote && snapshot.scoutDecision?.shouldPublish === true;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatorInput {
    return {
      scoutDecision: snapshot.scoutDecision!,
      trigger: snapshot.trigger!,
    };
  }

  protected async execute(input: CreatorInput, context: PipelineContext<PipelineFields>): Promise<CreatedContent> {
    const prompt = buildCreatorPrompt(input.scoutDecision, input.trigger);
    const facebook = input.trigger.platform === 'facebook';
    const raw = await executeWithRetry(
      async () => {
        return this.llmClient.chat(
          [
            { role: 'system', content: facebook ? '你是 Facebook 帖子创作者，严格按账号人设和发言语言生成 JSON 格式内容。' : '你是小红书笔记创作者，正文创作：严格按要求生成JSON格式内容。' },
            { role: 'user', content: prompt },
          ],
          // LLM 调用超时须与角色闸同放宽，否则 QwenClient 默认 30s 会先 abort（角色闸放宽也没用）。
          { timeoutMs: CONTENT_TIMEOUT_MS, accountId: this.accountIdFrom(context) },
        );
      },
      { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 },
    );
    const parsed = this.parseOutput(raw, input.trigger.platform);
    if (facebook) {
      const writingLanguage = input.trigger.generateInput.soul.writing_language;
      if (!writingLanguage) throw new Error('writing_language_required');
      if (checkWritingLanguage(parsed.content, writingLanguage) !== 'match') {
        throw new Error('writing_language_mismatch');
      }
    }
    return { ...parsed, createdAt: this.clock() };
  }

  private parseOutput(raw: string, platform: TriggerInput['platform']): Omit<CreatedContent, 'createdAt'> {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Creator output');
    // doubao 常把多行正文的换行不转义直接放进 JSON 字符串（Bad control character，正文角色切 doubao 后必炸）——
    // 先原样 parse，失败则只转义字符串内部裸控制字符后重试；仍失败照旧抛（诚实中止，不伪造内容）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse 返回值，与原实现同型
    let obj: any;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      obj = JSON.parse(escapeControlCharsInJsonStrings(match[0]));
    }
    // 小红书标题硬上限 20 字（超限「发布」按钮静默失效）。云端先截断至 20 兜底，edge 再截一次双保险。
    const title = String(obj.title || '').slice(0, platform === 'facebook' ? 80 : 20);
    return {
      title,
      content: String(obj.content || ''),
      // change split-topic-roles：正文角色不再产标签；话题改由 TopicGenerator/TopicEvaluator 依定稿正文另行生成。
      tags: [],
      tone: this.validateTone(obj.tone),
      style: typeof obj.style === 'object' && obj.style !== null ? obj.style : {},
    };
  }

  private validateTone(tone: unknown): CreatedContent['tone'] {
    const valid: CreatedContent['tone'][] = ['professional', 'casual', 'technical', 'narrative'];
    if (typeof tone === 'string' && valid.includes(tone as CreatedContent['tone'])) {
      return tone as CreatedContent['tone'];
    }
    return 'casual';
  }
}
