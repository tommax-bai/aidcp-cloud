/**
 * ProfileBrowser — 作者主页资料聚合角色。
 *
 * 职责：在作者资料就绪后产出 profile.browsed，携带真实粉丝数/作品数供 FollowAgent 判定。
 * 消费事件：
 *   - profile.entered：缓存本次主页访问的 authorId / sourcePageType（边缘尚未上报数据）
 *   - profile.detail.arrived：边缘上报作者资料到达 → 携带真实 counts emit profile.browsed
 * 产出事件：profile.browsed
 *
 * 不使用 LLM，纯执行角色。
 *
 * 注意（修复 data-broken）：旧实现消费 profile.entered 时读 getProfileData 恒得 null → counts 恒 0。
 * 现改为在 profile.detail.arrived（数据已就绪）后产出，并透传 extracted 标记，
 * 让 FollowAgent 区分"数据缺失"与"真 0 粉丝"。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName, ProfileEnteredPayload, ProfileDetailData } from '../event-bus/types.js';

export class ProfileBrowser extends BaseRole {
  readonly roleName: RoleName = 'profile_browser';
  private unsubscribers: (() => void)[] = [];
  /** 本次主页访问上下文（来自 profile.entered；边缘上报不含 sourcePageType）。 */
  private pending: { authorId: string; sourcePageType: 'feed' | 'search' } | null = null;

  constructor(options: RoleOptions) {
    super(options);
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('profile.entered', (p) => this.onEntered(p)),
      this.eventBus.on('profile.detail.arrived', (p) => this.onDetailArrived(p.detail)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.pending = null;
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private onEntered(payload: ProfileEnteredPayload): void {
    this.pending = { authorId: payload.authorId, sourcePageType: payload.sourcePageType };
  }

  private onDetailArrived(detail: ProfileDetailData): void {
    const sourcePageType = this.pending?.sourcePageType ?? 'feed';
    const authorId = detail.authorId || this.pending?.authorId || 'unknown';
    this.pending = null;

    this.emit('profile.browsed', {
      authorId,
      sourcePageType,
      postsCount: detail.postsCount,
      followersCount: detail.followersCount,
      likesCollects: detail.likesCollects,
      extracted: detail.extracted,
      ts: Date.now(),
    });
  }
}
