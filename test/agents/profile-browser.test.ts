import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ProfileBrowser } from '../../src/agents/profile-browser.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { ProfileBrowsedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

const sampleProfile = { postsCount: 42, followersCount: 1500 };

describe('ProfileBrowser', () => {
  it('收到 profile.entered → emit profile.browsed', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new ProfileBrowser({
      eventBus: bus,
      soul: mockSoul,
      sessionContext: ctx,
      getProfileData: () => sampleProfile,
    });
    role.subscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', {
      authorId: 'author_123',
      sourcePageType: 'feed',
      ts: Date.now(),
    });

    assert.ok(captured, 'should emit profile.browsed');
    assert.equal(captured!.authorId, 'author_123');
    assert.equal(captured!.sourcePageType, 'feed');
    assert.equal(captured!.postsCount, 42);
    assert.equal(captured!.followersCount, 1500);
  });

  it('profileData 为 null → emit profile.browsed with 0 counts', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new ProfileBrowser({
      eventBus: bus,
      soul: mockSoul,
      sessionContext: ctx,
      getProfileData: () => null,
    });
    role.subscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', {
      authorId: 'author_unknown',
      sourcePageType: 'search',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.postsCount, 0);
    assert.equal(captured!.followersCount, 0);
  });

  it('sourcePageType 透传正确', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new ProfileBrowser({
      eventBus: bus,
      soul: mockSoul,
      sessionContext: ctx,
      getProfileData: () => sampleProfile,
    });
    role.subscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', {
      authorId: 'author_456',
      sourcePageType: 'search',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');
  });

  it('authorId 透传正确', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new ProfileBrowser({
      eventBus: bus,
      soul: mockSoul,
      sessionContext: ctx,
      getProfileData: () => sampleProfile,
    });
    role.subscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', {
      authorId: 'specific_author_id',
      sourcePageType: 'feed',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.authorId, 'specific_author_id');
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new ProfileBrowser({
      eventBus: bus,
      soul: mockSoul,
      sessionContext: ctx,
      getProfileData: () => sampleProfile,
    });
    role.subscribe();
    role.unsubscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', {
      authorId: 'author_123',
      sourcePageType: 'feed',
      ts: Date.now(),
    });

    assert.equal(captured, null, 'should not emit after unsubscribe');
  });
});
