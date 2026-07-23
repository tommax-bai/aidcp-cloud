/**
 * CommentSearchTermGenerator — 「搜索词生成」角色（change comment-search-command，新角色①）。
 *
 * 用途：飞书 /comment 按需评论任务的第一步——读账号**人设兴趣** + **精选集**（curated_content
 * 高收藏笔记标题 / 主题）→ 生成一小批**有序**搜索词，供后续「逐词换词重试」消费。
 *
 * 判定类角色（browse_judge）：经 llm.complete 携带角色键 `browse:comment_search_term_generator`
 * 解析模型 / 温度（必须登记进 role-catalog，否则运行时回落全局默认模型——见 change
 * curated-admission-eval-roles 真机教训）。
 *
 * 红线：
 *  - 不编造：精选集稀疏 / LLM 降级 / 解析失败 → 退回人设 seed_keywords；种子词也空则诚实返回空集。
 *  - 不阻塞：失败只 log + 回退，不抛。
 *  - 账号隔离：精选样本由调用方按账号取（本角色不读库）。
 *
 * 非事件驱动：由评论任务编排（src/comment-agent/）命令式调用 generate()，不订阅 EventBus。
 */

import type { Soul } from '../kernel/soul-types.js';
import type { LlmCallOpts } from '../kernel/llm-contract.js';
import type { RoleName } from '../event-bus/types.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';

/** 角色侧只需文本补全；opts 携带角色键，客户端按角色解析模型/温度。 */
export interface RoleLlmLike {
  complete(prompt: string, opts?: LlmCallOpts): Promise<string>;
}

/** 精选集样本的窄投影（来自 CuratedContentStore.selectForCreation，调用方按账号取）。 */
export interface CuratedSampleForTerms {
  title?: string | null;
  topics?: string[] | null;
  collectCount?: number | null;
}

export interface CommentSearchTermGeneratorOptions {
  llm: RoleLlmLike;
  /** 人设注入：getSoul 优先（热加载、按账号），否则用构造期快照。 */
  soul?: Soul;
  getSoul?: () => Soul;
  platformProfile?: CommentPlatformProfile;
  /** 一次最多产出的搜索词数（缺省 5）。 */
  maxTerms?: number;
}

/** 搜索词生成结果。terms 有序（先用先试）；source 标注主要来源。 */
export interface SearchTermResult {
  terms: string[];
  source: 'persona' | 'curated' | 'mixed';
}

const ROLE_NAME: RoleName = 'comment_search_term_generator';
const DEFAULT_MAX_TERMS = 5;

export class CommentSearchTermGenerator {
  readonly roleName: RoleName = ROLE_NAME;
  private readonly llm: RoleLlmLike;
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: () => Soul;
  private readonly platformProfile: CommentPlatformProfile;
  private readonly maxTerms: number;

  constructor(options: CommentSearchTermGeneratorOptions) {
    if (!options.llm) throw new Error('CommentSearchTermGenerator 需要 LlmClient');
    this.llm = options.llm;
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.maxTerms = options.maxTerms ?? DEFAULT_MAX_TERMS;
  }

  private get soul(): Soul {
    if (this.getSoulFn) return this.getSoulFn();
    if (this.soulSnapshot) return this.soulSnapshot;
    throw new Error(`${this.roleName} 缺少人设注入（soul / getSoul 至少给一个）`);
  }

  /**
   * 生成搜索词。samples=按账号取到的精选集样本（可空）。
   * 失败 / 空 → 退回人设种子词（不编造）；种子词也空 → 诚实返回空集。
   */
  async generate(samples: CuratedSampleForTerms[] = []): Promise<SearchTermResult> {
    const seeds = this.seedKeywords();
    const curatedTitles = this.curatedTitles(samples);

    let raw: string;
    try {
      raw = await this.llm.complete(this.buildPrompt(curatedTitles), { role: `browse:${this.roleName}` });
    } catch (err) {
      // 诚实红线：LLM 降级 → 退回种子词，不抛、不阻塞任务。
      console.log(`[${this.roleName}] LLM 调用失败 → 退回种子词：${(err as Error).message}`);
      return { terms: this.dedupCap(seeds), source: 'persona' };
    }

    const terms = this.parseTerms(raw);
    if (!terms.length) {
      console.log(`[${this.roleName}] 解析空 → 退回种子词`);
      return { terms: this.dedupCap(seeds), source: 'persona' };
    }
    const source: SearchTermResult['source'] = curatedTitles.length ? (seeds.length ? 'mixed' : 'curated') : 'persona';
    return { terms: this.dedupCap(terms), source };
  }

  /** 只读预览（后台「查看 Prompt」）：最小示例数据 + 真实人设渲染真实 prompt。 */
  previewPrompt(): string {
    return this.buildPrompt(['<示例：精选集里你收藏过的高收藏笔记标题>']);
  }

  private seedKeywords(): string[] {
    return (this.soul.interests.seed_keywords ?? []).map((s) => s.trim()).filter(Boolean);
  }

  private curatedTitles(samples: CuratedSampleForTerms[]): string[] {
    return samples
      .map((s) => (s.title ?? '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  private dedupCap(terms: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of terms) {
      const v = t.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= this.maxTerms) break;
    }
    return out;
  }

  private buildPrompt(curatedTitles: string[]): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const seedStr = this.seedKeywords().join('、') || '（无）';
    const curatedBlock = curatedTitles.length
      ? curatedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '（暂无精选样本，请主要依据你的创作领域 / 兴趣与种子词。）';

    return `你是「${identity.name}」，${identity.role}。
你的创作领域 / 兴趣：${interestsStr}
你的种子关键词：${seedStr}

你打算去${this.platformProfile.siteName}搜一批**和你创作领域强相关**的${this.platformProfile.contentName}，准备在其中挑一篇留评论。
下面是你过去收藏 / 沉淀进「灵感库」的高价值笔记标题（反映你真正关注的细分方向）：
${curatedBlock}

请据此生成 ${this.maxTerms} 个**有序**的${this.platformProfile.siteName}搜索词（先放最贴合、最可能搜到强相关优质${this.platformProfile.contentName}的）。要求：
- 每个词都落在你的创作领域内，具体可搜（贴近真实用户搜法，2~8 字为宜）；
- 覆盖不同细分角度，彼此不重复；
- 若精选样本稀疏，就基于你的领域 / 兴趣 / 种子词来定，**不要编造与领域无关的词**。

只输出 JSON（不要其他内容）：
{"terms": ["搜索词1", "搜索词2", ...], "source": "persona 或 curated 或 mixed"}`;
  }

  /** 严格解析 terms 数组；解析失败 / 非字符串数组 → 空集（交由调用方退回种子词，绝不编造）。 */
  private parseTerms(raw: string): string[] {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!obj || typeof obj !== 'object') return [];
    const terms = (obj as Record<string, unknown>).terms;
    if (!Array.isArray(terms)) return [];
    return terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
  }
}
