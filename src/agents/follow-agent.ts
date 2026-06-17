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

  private buildPrompt(profile: ProfileBrowsedPayload, remaining: number): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    // 注意：小红书个人主页通常**不公开作品数**（postsCount 多为 0=未知），故不把"作品数"
    // 当作核心评估维度，否则会因"作品0"一律拒绝、白瞎真实粉丝数。以主题相关度 + 粉丝数为主。
    const postsLine = profile.postsCount > 0
      ? `作品数：${profile.postsCount}`
      : `作品数：未知（小红书主页通常不公开，请勿据此判定质量差）`;

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
你正在浏览一位博主的个人主页，需要决定是否关注该博主。

博主信息：
作者ID：${profile.authorId}
粉丝数：${profile.followersCount}
${postsLine}

剩余关注配额：${remaining}

评估维度（按重要性）：
- 主题相关度：该博主内容方向是否与你的兴趣高度吻合（最重要）
- 受众与价值：粉丝数是否说明有一定受众；粉丝少也可能是优质新人，结合主题综合判断
- 长期关注价值：是否值得长期跟进该博主
（作品数为"未知"时不要作为扣分项——以主题相关度和粉丝数为主。）

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
