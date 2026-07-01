import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TitleSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildTitlePrompt, BANNED_PHRASES } from '../prompts.js';
import { clampTitle, graphemeCount } from '../title-clamp.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * TitleCreator（change dedicated-title-creator-role）。
 *
 * 把"标题生成"从内容生成里拆成独立角色，排在**正文定稿之后、发布之前**：依据定稿正文单独拟标题，
 * 治旧链路的两个病——① 标题在装配处被丢弃、真正发出的"标题"其实是正文首行盲切；② 注意力稀释。
 *
 * 红线：标题失败 = 发布失败（`fallback:'abort'`）。LLM/解析/重试用尽仍拿不到可解析标题 → **抛错**，
 * 不写 `titleSelection`、不派生假标题；下游因 waitAll 缺键不发布、编排器即时判 failed。
 * 长度收口在此一处（写入即 ≤TITLE_MAX、字形安全），edge 不再做任何标题截断。
 */

/** 标题可见字符硬上限：18（提示词目标 18；XHS >20 静默拒发，云端切 18 留 2 字余量吸收计数分歧）。 */
const TITLE_MAX = 18;
/** 标题生成超时（角色闸 + LLM 调用同值）：120s，容纳较强/较慢模型。env 可调。 */
const TITLE_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_TITLE_TIMEOUT_MS ?? 180_000);
/** 语义重试次数（首次 + 重试 ≤2）。 */
const MAX_ATTEMPTS = 3;
/** TitleCreator 专用 system（含「标题创作」标识，与 ContentCreator 的「小红书技术博主」相区分，便于按 system 路由的桩）。 */
const TITLE_SYSTEM = '你是小红书爆款标题创作专家。严格按要求只输出 JSON 格式的标题。';

export interface TitleCreatorDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface TitleInput {
  body: string;
  persona: string;
  styleType: string;
  seedTitle?: string;
}

export class TitleCreatorRole extends BasePublishRole<TitleInput, TitleSelection> {
  readonly config: RoleConfig = {
    name: 'TitleCreator',
    watchKeys: ['assembledContent'],
    timeoutMs: TITLE_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'titleSelection' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: TitleCreatorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TitleInput {
    // 标题忠于**真正发出的文字**：取定稿正文 finalContent，而非 createdContent.content（草稿）。
    const body = snapshot.assembledContent?.finalContent ?? '';
    const created = snapshot.createdContent;
    const identity = snapshot.trigger?.generateInput?.soul?.identity;
    const persona = identity
      ? `${identity.role}｜${identity.background}（语气：${identity.tone}）`
      : '小红书技术博主';
    return {
      body,
      persona,
      styleType: created?.style?.type ?? '',
      seedTitle: created?.title || undefined,
    };
  }

  protected async execute(input: TitleInput, _context: PipelineContext<PipelineFields>): Promise<TitleSelection> {
    // 空正文（上游降级）→ 诚实空标题（XHS 允许空标题，绝不编造占位、也不白调一次 LLM）。
    if (input.body.trim().length === 0) {
      this.logger.warn('[TitleCreator] 定稿正文为空 → 写空标题（source=derived）');
      return { title: '', source: 'derived', decidedAt: this.clock() };
    }

    const prompt = buildTitlePrompt(input.body, input.persona, input.styleType, input.seedTitle);
    let candidate: string | null = null;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const nudge =
          attempt === 0
            ? undefined
            : '上一个标题不合规（过长 / 含禁用词 / 含省略号 / 结尾带标点）。请重写：严格 ≤18 个可见字符、无省略号、无禁用词、结尾不带标点，只输出 {"title":"…"}。';
        const raw = await this.llmClient.chat(
          [
            { role: 'system', content: TITLE_SYSTEM },
            { role: 'user', content: nudge ? `${prompt}\n\n${nudge}` : prompt },
          ],
          // LLM 调用超时须与角色闸同放宽，否则 QwenClient 默认 30s 会先 abort。
          { timeoutMs: TITLE_TIMEOUT_MS },
        );
        const title = this.parseTitle(raw); // 无可解析标题则抛
        candidate = title; // 即便不合规也留作候选，最终经 clamp 收口
        if (this.isClean(title)) break;
        this.logger.warn(`[TitleCreator] 标题不合规（attempt ${attempt + 1}），重试: ${JSON.stringify(title)}`);
      } catch (err) {
        lastErr = err as Error;
        this.logger.warn(`[TitleCreator] 生成失败（attempt ${attempt + 1}）: ${(err as Error).message}`);
      }
    }

    // 红线：始终拿不到可解析标题 → 抛错走 abort（不写键、不派生假标题）。
    if (candidate == null) {
      throw lastErr ?? new Error('TitleCreator: 重试用尽仍无可解析标题');
    }

    // 长度收口（字形安全，绝不切碎汉字/emoji；保证 ≤TITLE_MAX）。
    const title = clampTitle(candidate, TITLE_MAX);
    return { title, source: 'llm', decidedAt: this.clock() };
  }

  /** 解析 LLM 输出里的 {"title":"…"}；无 JSON 或无非空 title 则抛（交由重试/abort 处理）。 */
  private parseTitle(raw: string): string {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('TitleCreator: 输出无 JSON');
    const obj = JSON.parse(match[0]);
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) throw new Error('TitleCreator: JSON 无非空 title');
    return title;
  }

  /** 合规判定：≤TITLE_MAX 可见字符、无省略号、无禁用词。不合规则触发语义重试。 */
  private isClean(title: string): boolean {
    if (graphemeCount(title) > TITLE_MAX) return false;
    if (/(\.\.\.|…)/u.test(title)) return false;
    if (BANNED_PHRASES.some((p) => title.includes(p))) return false;
    return true;
  }
}
