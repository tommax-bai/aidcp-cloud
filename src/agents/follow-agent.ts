/**
 * FollowAgent — 关注评估与执行角色（LLM）。
 *
 * 职责：评估并执行关注动作。
 * 消费事件：profile.browsed
 * 产出事件：profile.done（followed=true/false）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName, ProfileBrowsedPayload } from '../event-bus/types.js';

export interface FollowAgentOptions extends RoleOptions {
  sessionContext: SessionContext;
  getRemainingFollows: () => number;
}

export class FollowAgent extends BaseRole {
  readonly roleName: RoleName = 'follow_agent';
  private readonly getRemainingFollows: () => number;
  private unsubscribers: (() => void)[] = [];

  constructor(options: FollowAgentOptions) {
    super(options);
    if (!options.llm) throw new Error('FollowAgent 需要 LlmClient');
    this.getRemainingFollows = options.getRemainingFollows;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('profile.browsed', (p) => this.onProfileBrowsed(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private async onProfileBrowsed(payload: ProfileBrowsedPayload): Promise<void> {
    const remaining = this.getRemainingFollows();

    // 配额耗尽，直接 skip
    if (remaining <= 0) {
      this.emit('profile.done', {
        authorId: payload.authorId,
        sourcePageType: payload.sourcePageType,
        followed: false,
        ts: Date.now(),
      });
      return;
    }

    // 作者资料未成功抽取（进了主页但没拿到粉丝/作品数）→ 保守 skip。
    // 关键：不要把"数据缺失"当成"真 0 粉丝低质量"——这正是历史上 follow 恒拒的假信号根因。
    if (payload.extracted === false) {
      this.log('作者资料不可用（extracted=false）→ 保守 skip，不在缺失数据上判定');
      this.emit('profile.done', {
        authorId: payload.authorId,
        sourcePageType: payload.sourcePageType,
        followed: false,
        ts: Date.now(),
      });
      return;
    }

    const prompt = this.buildPrompt(payload, remaining);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      this.emit('profile.done', {
        authorId: payload.authorId,
        sourcePageType: payload.sourcePageType,
        followed: false,
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('profile.done', {
        authorId: payload.authorId,
        sourcePageType: payload.sourcePageType,
        followed: false,
        ts: Date.now(),
      });
      return;
    }

    this.emit('profile.done', {
      authorId: payload.authorId,
      sourcePageType: payload.sourcePageType,
      followed: result.verdict === 'follow',
      ts: Date.now(),
    });
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ authorId: '<示例authorId>', sourcePageType: 'feed', postsCount: 0, followersCount: 0, likesCollects: 0, extracted: true, ts: 0 }, 1);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。`];
  }

  private buildPrompt(profile: ProfileBrowsedPayload, remaining: number): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    // 小红书个人主页【不公开作品数】，故 prompt 完全不提"作品数"——提了 LLM 会据一个永不可得的
    // 字段 skip（实测 follow_agent 仍以"作品数未知"拒关 130 粉丝/6707 获赞的真创作者）。
    // 以主题相关度 + 粉丝数 + 获赞与收藏（主页真实提供的质量信号）综合判断。
    const lc = profile.likesCollects;
    const engagementLine = lc != null && lc > 0 ? `获赞与收藏：${lc}` : `获赞与收藏：未知`;

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
你正在浏览一位博主的个人主页，需要决定是否关注该博主。

博主信息：
作者ID：${profile.authorId}
粉丝数：${profile.followersCount}
${engagementLine}

剩余关注配额：${remaining}

评估维度（按重要性）：
- 主题相关度：该博主内容方向是否与你的兴趣高度吻合（最重要）
- 受众与活跃度：粉丝数、获赞与收藏是否说明有一定受众与影响力；数据偏低也可能是优质新人，结合主题综合判断
- 长期关注价值：是否值得长期跟进该博主
（请仅凭主题相关度、粉丝数、获赞与收藏综合判断；不要因为主页某些统计项缺失/未知而 skip。）

只输出JSON（不要输出其他内容）：
关注：{"verdict":"follow","reason":"简短原因","confidence":0.8}
不关注：{"verdict":"skip","reason":"简短原因"}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string): FollowResult | null {
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

    if (o.verdict === 'follow') {
      const reason = typeof o.reason === 'string' ? o.reason : 'worth_following';
      return { verdict: 'follow', reason };
    } else if (o.verdict === 'skip') {
      const reason = typeof o.reason === 'string' ? o.reason : 'not_worth';
      return { verdict: 'skip', reason };
    }

    return null;
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface FollowResultFollow {
  verdict: 'follow';
  reason: string;
}

interface FollowResultSkip {
  verdict: 'skip';
  reason: string;
}

type FollowResult = FollowResultFollow | FollowResultSkip;
