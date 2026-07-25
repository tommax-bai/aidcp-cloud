/**
 * PersonaGenerator — 「建号自助人设生成」角色（change edge-persona-keyword-generation）。
 *
 * 用途：客户在 Electron 客户端扫码登录后，勾选几类关键词 → 本角色调云端大模型生成一份 soul 草稿
 * （identity + interests），供边缘展示、客户确认后走现有校验写入通道落库。命令式，非 EventBus 订阅。
 *
 * 判定/创作类角色：经 llm.complete 携角色键 `browse:persona_generator` 解析模型/温度
 * （必须登记进 role-catalog，否则回落全局默认模型——见 curated-admission 真机教训）。
 *
 * 红线：
 *  - fail-closed：大模型超时 / 输出不可解析 / 校验不过 → 重试有限次仍失败则诚实返回 { ok:false, reason }，
 *    绝不回落任何模板/默认人设、绝不返回半成品 soul（宁缺毋假、不静默假成功）。
 *  - 大模型吐 JSON（不直吐 YAML，避开自写极简解析器对缩进 fail-fast），云端确定性序列化成 soul YAML
 *    再 loadSoulFromYaml round-trip 自校验。
 *  - 抗跨账号同质化：每账号差异化种子拌进 prompt，差异化重点落在 seed_keywords（真封号链路）。
 *  - 保真：背景不得编造具体可核验经历/头衔（否则诱发发布链第一人称虚构亲历）。
 *
 * LLM 只产 identity + interests（含 seed_keywords）；behavior_guidelines 由代码据生成结果与受控点赞倾向确定性补齐。
 */

import type { BehaviorGuidelines, LikeAffinity, Soul, WritingLanguage } from '../kernel/soul-types.js';
import type { YamlValue } from '../kernel/yaml.js';
import { loadSoulFromValue, loadSoulFromYaml, serializeSoul } from '../soul/index.js';
import { DEFAULT_LIKE_AFFINITY, generatedLikePrinciple, LIKE_AFFINITY_VALUES } from '../kernel/like-affinity.js';
import type { TextCompletionPort } from '../kernel/llm-contract.js';

// change cloud-coupling-phase0：`as const` 替代跨边界的角色名联合标注；防线见 content-role-names 合同测试。
const ROLE_NAME = 'persona_generator' as const;
const ROLE_KEY = `browse:${ROLE_NAME}`;
const DEFAULT_MAX_RETRIES = 2;
export const LIKE_AFFINITY_KEYWORD_PREFIX = 'like_affinity:';
const LIKE_AFFINITY_SET = new Set<LikeAffinity>(LIKE_AFFINITY_VALUES);

export function extractLikeAffinitySelection(keywordSelections: string[]): {
  keywords: string[];
  likeAffinity: LikeAffinity;
} {
  const keywords: string[] = [];
  const affinityMarkers: LikeAffinity[] = [];
  for (const raw of keywordSelections ?? []) {
    const value = raw.trim();
    if (!value) continue;
    if (value.startsWith(LIKE_AFFINITY_KEYWORD_PREFIX)) {
      const affinity = value.slice(LIKE_AFFINITY_KEYWORD_PREFIX.length) as LikeAffinity;
      if (LIKE_AFFINITY_SET.has(affinity)) affinityMarkers.push(affinity);
      continue;
    }
    keywords.push(value);
  }
  return {
    keywords,
    likeAffinity: affinityMarkers.length === 1 ? affinityMarkers[0] : DEFAULT_LIKE_AFFINITY,
  };
}

export interface PersonaGeneratorOptions {
  llm: TextCompletionPort;
  /** 单次生成失败后的最大重试次数（默认 2；含首次共尝试 3 次）。 */
  maxRetries?: number;
}

export interface PersonaGenerateInput {
  /** 账号标识（token 按账号记账；云端已以握手绑定 accountId 为准，本值仅用于记账归属）。 */
  accountId: string;
  /** 客户勾选的垂类/兴趣/语气关键词，以及可选受控 like_affinity 标记。 */
  keywordSelections: string[];
  /** Facebook-only，由 Cloud 入口校验后确定性注入，模型不得决定。 */
  writingLanguage?: WritingLanguage;
  /** 每账号差异化种子（调用方注入，如 accountId + nonce）：拌进 prompt 抗跨账号同质化。 */
  diversitySeed?: string;
}

export type PersonaGenerateOutcome =
  | { ok: true; soulYaml: string; identitySummary: string }
  | { ok: false; reason: 'no_keywords' | 'generation_failed' | 'persona_invalid' };

export class PersonaGenerator {
  readonly roleName = ROLE_NAME;
  private readonly llm: TextCompletionPort;
  private readonly maxRetries: number;

  constructor(options: PersonaGeneratorOptions) {
    if (!options.llm) throw new Error('PersonaGenerator 需要 LlmClient');
    this.llm = options.llm;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * 生成人设草稿。fail-closed：任何环节失败重试有限次，仍失败返回 { ok:false, reason }（绝不兜底/半成品）。
   */
  async generate(input: PersonaGenerateInput): Promise<PersonaGenerateOutcome> {
    const { keywords: kws, likeAffinity } = extractLikeAffinitySelection(input.keywordSelections ?? []);
    if (!kws.length) return { ok: false, reason: 'no_keywords' };

    let lastReason: 'generation_failed' | 'persona_invalid' = 'generation_failed';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let raw: string;
      try {
        raw = await this.llm.complete(this.buildPrompt(kws, input.diversitySeed, attempt), {
          role: ROLE_KEY,
          accountId: input.accountId,
        });
      } catch (err) {
        console.log(`[${ROLE_NAME}] LLM 调用失败(attempt ${attempt}): ${(err as Error).message}`);
        lastReason = 'generation_failed';
        continue;
      }

      const parsed = this.parseSoulJson(raw);
      if (!parsed) {
        console.log(`[${ROLE_NAME}] 输出非合法 JSON(attempt ${attempt}) → 重试/失败`);
        lastReason = 'persona_invalid';
        continue;
      }

      // 结构校验：直接在 JSON 对象上过 loadSoulFromValue（避开 YAML 语法层脆弱性）。
      let soul: Soul;
      try {
        soul = loadSoulFromValue(parsed as YamlValue);
        soul = {
          ...soul,
          ...(input.writingLanguage ? { writing_language: input.writingLanguage } : {}),
          behavior_guidelines: this.buildBehaviorGuidelines(soul, likeAffinity),
        };
      } catch (err) {
        console.log(`[${ROLE_NAME}] 结构校验不过(attempt ${attempt}): ${(err as Error).message}`);
        lastReason = 'persona_invalid';
        continue;
      }

      // 确定性序列化成 soul YAML + round-trip 自校验（防序列化漂移，落库前再兜一道）。
      const soulYaml = serializeSoul(soul);
      try {
        loadSoulFromYaml(soulYaml);
      } catch (err) {
        console.log(`[${ROLE_NAME}] 序列化 round-trip 失败(attempt ${attempt}): ${(err as Error).message}`);
        lastReason = 'persona_invalid';
        continue;
      }

      return { ok: true, soulYaml, identitySummary: this.summarize(soul) };
    }
    return { ok: false, reason: lastReason };
  }

  /** 只读预览（后台「查看 Prompt」）。 */
  previewPrompt(): string {
    return this.buildPrompt(['<示例：客户勾选的关键词，如 美妆 / 护肤 / 活泼>'], '<示例：每账号差异化种子>', 0);
  }

  private summarize(soul: Soul): string {
    const seeds = soul.interests.seed_keywords.slice(0, 3).join('、');
    return `${soul.identity.name}·${soul.identity.role}${seeds ? `（搜索方向：${seeds}）` : ''}`;
  }

  private buildBehaviorGuidelines(soul: Soul, likeAffinity: LikeAffinity): BehaviorGuidelines {
    return {
      style: `${soul.identity.tone}；浏览、点赞与收藏保持自然、有分寸`,
      privacy: '不编造私人经历或关系，不因互动倾向泄露隐私、盲目回关或做越权承诺',
      collection_principle: '只收藏会反复参考、能直接复用或确有长期价值的内容；收藏比点赞更稀有',
      like_principle: generatedLikePrinciple(likeAffinity, soul.interests.primary),
      like_affinity: likeAffinity,
    };
  }

  private buildPrompt(keywords: string[], diversitySeed: string | undefined, attempt: number): string {
    const kwLine = keywords.join('、');
    const diversityBlock = diversitySeed
      ? `\n差异化提示（务必据此让本账号与同垂类其他账号明显不同，尤其体现在 seed_keywords 的具体选词上）：${diversitySeed}`
      : '';
    const retryNudge = attempt > 0
      ? '\n（上一次输出不合规，请严格只输出符合下面结构的 JSON，不要任何解释文字。）'
      : '';

    return `你要为一个社交媒体账号设计一份「人设」（persona），供该账号后续浏览/互动/发布时保持一致的身份与口味。
客户勾选的关键词：${kwLine}${diversityBlock}${retryNudge}

请生成一份人设，包含身份与兴趣两部分。要求：
- identity.name：一个贴合领域的中文昵称/人设名，像真实用户会用的网名；不要用具体真实公众人物/明星/品牌的真名。
- identity.role：这个账号的身份定位（如「爱折腾的护肤成分党」）。
- identity.background：可信但克制的背景，一两句即可；**不得编造具体可核验的经历/项目/雇主/头衔/获奖**（避免日后写出无法背书的第一人称亲历）。
- identity.tone：可直接当写作腔调用的短语（示例风格：「技术向、理性、偶尔幽默」「亲切、爱分享、接地气」），不要只写一个形容词。
- interests.primary：3~5 个核心兴趣领域（有轻重、分层）。
- interests.secondary：2~4 个次要兴趣。
- interests.seed_keywords：6~8 个**真实可搜**的搜索词（贴近真实用户在该平台的搜法，2~8 字为宜），具体、彼此不同、紧扣领域；这是账号真正会去搜的词，务必据差异化提示做出区分度，**不要用空泛大词或生造词**。

只输出 JSON（不要任何其他内容）：
{"identity":{"name":"...","role":"...","background":"...","tone":"..."},"interests":{"primary":["..."],"secondary":["..."],"seed_keywords":["..."]}}`;
  }

  /** 严格从模型输出截取 JSON 对象并解析；失败返回 null（交由调用方重试/诚实失败，绝不编造）。 */
  private parseSoulJson(raw: string): Record<string, unknown> | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  }
}
