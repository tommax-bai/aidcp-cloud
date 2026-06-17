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

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
你正在浏览一位博主的个人主页，需要决定是否关注该博主。

博主信息：
作者ID：${profile.authorId}
作品数：${profile.postsCount}
粉丝数：${profile.followersCount}

剩余关注配额：${remaining}

评估维度：
- 内容质量稳定性：作品数是否足够多（说明持续输出能力）
- 更新频率：作品数量可间接推断更新频率
- 主题相关度：该博主领域是否与你的兴趣相关
- 粉丝数合理性：粉丝数适中说明内容有受众

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
