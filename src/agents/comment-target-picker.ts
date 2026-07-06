/**
 * CommentTargetPicker — 「搜索笔记甄选」角色（change comment-search-command，新角色②）。
 *
 * 用途：飞书 /comment 按需评论任务里，对**某个搜索词**「最多收藏 + 一天内」原生筛选并**去重后**的
 * 候选卡片，判定**人设强相关**（不是沾边 / 泛泛相关），并在强相关候选里挑**收藏最高的一篇**。
 * 当前词无强相关候选 → pickIndex=null（编排据此换下一个搜索词重试）。
 *
 * 判定类角色（browse_judge）：经 llm.complete 携带角色键 `browse:comment_target_picker` 解析模型 / 温度
 * （必须登记进 role-catalog，否则回落全局默认模型）。
 *
 * 红线：
 *  - 强相关：只在 LLM 判定强相关的候选里挑；弱相关 / 不相关 MUST NOT 入选。
 *  - 确定性「最多收藏」：在强相关候选里按收藏数取最高（不完全信 LLM 的 pickIndex，做云端兜底）。
 *  - 诚实：无候选 / 解析失败 → pickIndex=null（绝不默认挑一篇）。
 *
 * 非事件驱动：由评论任务编排（src/comment-agent/）命令式调用 pick()，不订阅 EventBus。
 */

import type { Soul } from '../soul/types.js';
import type { RoleName } from '../event-bus/types.js';
import type { RoleLlmLike } from './comment-search-term-generator.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';

/** 一张去重后的搜索结果候选卡片（窄投影）。 */
export interface CommentCandidateCard {
  /** 在本次候选列表中的下标（与 LLM 输出对齐）。 */
  index: number;
  noteId?: string;
  title: string;
  author?: string;
  /** 平台收藏数（原生「最多收藏」排序后多已带回；缺失则视为 0 参与排序，但不编造）。 */
  collectCount?: number | null;
  likeCount?: number | null;
}

export interface CommentTargetPickerOptions {
  llm: RoleLlmLike;
  soul?: Soul;
  getSoul?: () => Soul;
  platformProfile?: CommentPlatformProfile;
}

/** 甄选结果：pickIndex=选中的候选下标（无则 null）；stronglyRelevantIndexes=判为强相关的全部下标。 */
export interface PickResult {
  pickIndex: number | null;
  stronglyRelevantIndexes: number[];
  reason: string;
}

const ROLE_NAME: RoleName = 'comment_target_picker';

export class CommentTargetPicker {
  readonly roleName: RoleName = ROLE_NAME;
  private readonly llm: RoleLlmLike;
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: () => Soul;
  private readonly platformProfile: CommentPlatformProfile;

  constructor(options: CommentTargetPickerOptions) {
    if (!options.llm) throw new Error('CommentTargetPicker 需要 LlmClient');
    this.llm = options.llm;
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
  }

  private get soul(): Soul {
    if (this.getSoulFn) return this.getSoulFn();
    if (this.soulSnapshot) return this.soulSnapshot;
    throw new Error(`${this.roleName} 缺少人设注入（soul / getSoul 至少给一个）`);
  }

  /**
   * 甄选一篇。candidates=某搜索词去重后的候选卡片。
   * 无候选 / 失败 / 无强相关 → pickIndex=null（编排据此换下一个词；不强评弱相关）。
   */
  async pick(candidates: CommentCandidateCard[]): Promise<PickResult> {
    if (!candidates.length) return { pickIndex: null, stronglyRelevantIndexes: [], reason: 'no_candidates' };

    let raw: string;
    try {
      raw = await this.llm.complete(this.buildPrompt(candidates), { role: `browse:${this.roleName}` });
    } catch (err) {
      console.log(`[${this.roleName}] LLM 调用失败 → 不挑（换词）：${(err as Error).message}`);
      return { pickIndex: null, stronglyRelevantIndexes: [], reason: 'llm_error' };
    }

    const parsed = this.parse(raw, candidates);
    if (!parsed) {
      console.log(`[${this.roleName}] 解析失败 → 不挑（换词）`);
      return { pickIndex: null, stronglyRelevantIndexes: [], reason: 'parse_error' };
    }

    const strong = parsed.stronglyRelevantIndexes;
    if (!strong.length) {
      return { pickIndex: null, stronglyRelevantIndexes: [], reason: parsed.reason || 'no_strong_match' };
    }

    // 确定性「最多收藏」：在强相关候选里按收藏数取最高（不完全信 LLM 的 pickIndex）。
    const byIndex = new Map(candidates.map((c) => [c.index, c]));
    const best = strong
      .map((i) => byIndex.get(i))
      .filter((c): c is CommentCandidateCard => !!c)
      .sort((a, b) => (b.collectCount ?? 0) - (a.collectCount ?? 0))[0];

    if (!best) return { pickIndex: null, stronglyRelevantIndexes: strong, reason: 'no_strong_match' };
    return { pickIndex: best.index, stronglyRelevantIndexes: strong, reason: parsed.reason || 'picked' };
  }

  /** 只读预览（后台「查看 Prompt」）。 */
  previewPrompt(): string {
    return this.buildPrompt([
      { index: 0, title: '<示例候选标题 A>', author: '<作者>', collectCount: 1200 },
      { index: 1, title: '<示例候选标题 B>', author: '<作者>', collectCount: 800 },
    ]);
  }

  private buildPrompt(candidates: CommentCandidateCard[]): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    const list = candidates
      .map((c) => `${c.index}. 《${c.title}》 ｜ 作者:${c.author ?? '未知'} ｜ 收藏:${c.collectCount ?? 0}`)
      .join('\n');

    return `你是「${identity.name}」，${identity.role}。
你的创作领域 / 兴趣：${interestsStr}

下面是按「${this.platformProfile.search.defaultTimeWindowLabel} + ${this.platformProfile.search.defaultSortLabel}」筛出、且你尚未评论过的${this.platformProfile.siteName}候选${this.platformProfile.contentName}。
你要从中选一篇**和你创作领域强相关**的来留评论。

**强相关**= 这篇笔记的主题正落在你的创作领域核心、你能以内行视角自然地搭话；
**不算强相关**= 只是沾边 / 蹭到一个词 / 泛泛相关 / 跨界但不深——这些一律排除。

候选（index. 标题 ｜ 作者 ｜ 收藏数）：
${list}

判断每一篇是否与你的创作领域**强相关**，给出全部强相关候选的 index 列表；
若有强相关候选，从中选**收藏最高**的一篇作为 pickIndex；
若没有任何一篇强相关，pickIndex 置 null（宁可这次不评，也不在弱相关的笔记下凑评论）。

只输出 JSON（不要其他内容）：
{"pickIndex": 数字或 null, "stronglyRelevantIndexes": [强相关的 index...], "reason": "简短中文理由"}`;
  }

  /** 严格解析；stronglyRelevantIndexes 必须是合法 index 数组，pickIndex 必须在其中或为 null。 */
  private parse(
    raw: string,
    candidates: CommentCandidateCard[],
  ): { pickIndex: number | null; stronglyRelevantIndexes: number[]; reason: string } | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;

    const valid = new Set(candidates.map((c) => c.index));
    const strongRaw = Array.isArray(o.stronglyRelevantIndexes) ? o.stronglyRelevantIndexes : [];
    const stronglyRelevantIndexes = strongRaw
      .filter((i): i is number => typeof i === 'number' && valid.has(i))
      .filter((i, k, arr) => arr.indexOf(i) === k);

    let pickIndex: number | null = null;
    if (typeof o.pickIndex === 'number' && stronglyRelevantIndexes.includes(o.pickIndex)) {
      pickIndex = o.pickIndex;
    }
    const reason = typeof o.reason === 'string' ? o.reason : '';
    return { pickIndex, stronglyRelevantIndexes, reason };
  }
}
