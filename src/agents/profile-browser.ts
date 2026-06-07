/**
 * ProfileBrowser — 浏览博主主页角色。
 *
 * 职责：浏览博主个人主页内容（作品列表、简介、粉丝数等）。
 * 消费事件：profile.entered
 * 产出事件：profile.browsed
 *
 * 不使用 LLM，纯执行角色。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName, ProfileEnteredPayload } from '../event-bus/types.js';

export interface ProfileBrowserOptions extends RoleOptions {
  sessionContext: SessionContext;
  getProfileData: (authorId: string) => { postsCount: number; followersCount: number } | null;
}

export class ProfileBrowser extends BaseRole {
  readonly roleName: RoleName = 'profile_browser';
  private readonly getProfileData: (authorId: string) => { postsCount: number; followersCount: number } | null;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ProfileBrowserOptions) {
    super(options);
    this.getProfileData = options.getProfileData;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('profile.entered', (p) => this.handleProfileEntered(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleProfileEntered(payload: ProfileEnteredPayload): void {
    const profileData = this.getProfileData(payload.authorId);
    const postsCount = profileData?.postsCount ?? 0;
    const followersCount = profileData?.followersCount ?? 0;

    this.emit('profile.browsed', {
      authorId: payload.authorId,
      sourcePageType: payload.sourcePageType,
      postsCount,
      followersCount,
      ts: Date.now(),
    });
  }
}
