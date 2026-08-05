import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ScoutDecision, TriggerInput, CreatedContent } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildCreatorPrompt } from '../prompts.js';
import { escapeControlCharsInJsonStrings } from '../json-repair.js';
import { executeWithRetry } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';
import { checkWritingLanguage } from '../../kernel/writing-language.js';
import { bodyLengthCorrection, judgeBodyLength, type BodyLengthVerdict } from '../body-length-band.js';

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
    const system = facebook
      ? '你是 Facebook 帖子创作者，严格按账号人设和发言语言生成 JSON 格式内容。'
      : '你是小红书笔记创作者，正文创作：严格按要求生成JSON格式内容。';
    const generate = async (correction: string): Promise<Omit<CreatedContent, 'createdAt'>> => {
      const raw = await executeWithRetry(
        async () => {
          return this.llmClient.chat(
            [
              { role: 'system', content: system },
              { role: 'user', content: correction ? `${prompt}\n${correction}` : prompt },
            ],
            // LLM 调用超时须与角色闸同放宽，否则 QwenClient 默认 30s 会先 abort（角色闸放宽也没用）。
            { timeoutMs: CONTENT_TIMEOUT_MS, accountId: this.accountIdFrom(context) },
          );
        },
        { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 },
      );
      return this.parseOutput(raw, input.trigger.platform);
    };

    const parsed = await this.createWithinLengthBand(generate, input.trigger.platform);
    if (facebook) {
      const writingLanguage = input.trigger.generateInput.soul.writing_language;
      if (!writingLanguage) throw new Error('writing_language_required');
      if (checkWritingLanguage(parsed.content, writingLanguage) !== 'match') {
        throw new Error('writing_language_mismatch');
      }
    }
    return { ...parsed, createdAt: this.clock() };
  }

  /**
   * 正文长度的确定性闸（5.3b）：在此之前区间只活在 prompt 的一行文案里，云端一个字都不数，
   * 唯一数字数的 `content_too_long` 要等到发布指令下发前才响——图已生成、人已审过。
   *
   * 只对 `out_of_tolerance` 重写，且**只重写一次**：
   *  - 近区间（`near_band`）不重写——超几个字就重掷一次骰子等于给几乎每一篇多烧一次模型调用，
   *    而后果只是文章长了点、可恢复。按红线「概率低 × 后果可恢复 = 不加闸，记档即可」。
   *  - 重写仍离谱则**采用较接近的那一稿并响亮记录，MUST NOT 中止管线**：区间是质量目标不是物理约束，
   *    为它废掉一篇稿子是过度加闸；而静默采用又是另一半错误——所以必须留下这行日志。
   *  - 也 MUST NOT 截断：截出来的是残句，且会把「模型没听话」伪装成「一切正常」。
   */
  private async createWithinLengthBand(
    generate: (correction: string) => Promise<Omit<CreatedContent, 'createdAt'>>,
    platform: TriggerInput['platform'],
  ): Promise<Omit<CreatedContent, 'createdAt'>> {
    const first = await generate('');
    const firstVerdict = judgeBodyLength(first.content, platform);
    if (firstVerdict.kind !== 'out_of_tolerance') {
      if (firstVerdict.kind === 'near_band') this.warnLengthDeviation('采用', firstVerdict, platform);
      return first;
    }

    this.logger.warn(
      `[ContentCreator] 正文长度越界过大（${this.describeVerdict(firstVerdict, platform)}）→ 带纠正说明重写一次`,
    );
    const second = await generate(bodyLengthCorrection(firstVerdict));
    const secondVerdict = judgeBodyLength(second.content, platform);
    if (secondVerdict.kind !== 'out_of_tolerance') {
      if (secondVerdict.kind === 'near_band') this.warnLengthDeviation('重写后采用', secondVerdict, platform);
      return second;
    }

    // 两稿都离谱：取偏离更小的那一稿。相等时取重写稿（它至少见过纠正说明）。
    const keepFirst = firstVerdict.overshoot < secondVerdict.overshoot;
    const kept = keepFirst ? firstVerdict : secondVerdict;
    this.logger.warn(
      `[ContentCreator] 重写后仍越界过大，采用偏离较小的一稿（${this.describeVerdict(kept, platform)}；`
      + `另一稿 ${keepFirst ? secondVerdict.length : firstVerdict.length} 字）。`
      + '未截断、未中止——区间是质量目标，不是物理约束。',
    );
    return keepFirst ? first : second;
  }

  private warnLengthDeviation(action: string, verdict: BodyLengthVerdict, platform: TriggerInput['platform']): void {
    this.logger.warn(`[ContentCreator] 正文长度略越界，${action}（${this.describeVerdict(verdict, platform)}）`);
  }

  private describeVerdict(verdict: BodyLengthVerdict, platform: TriggerInput['platform']): string {
    const band = verdict.band ? `${verdict.band.min}-${verdict.band.max}` : '无区间';
    return `platform=${platform ?? 'xiaohongshu'} 实测=${verdict.length}字 区间=${band} 偏离=${verdict.overshoot}字`;
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
