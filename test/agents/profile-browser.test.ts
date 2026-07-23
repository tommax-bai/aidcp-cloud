import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ProfileBrowser } from '../../src/agents/profile-browser.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { ProfileBrowsedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

function newBrowser(bus: EventBus): ProfileBrowser {
  const role = new ProfileBrowser({ eventBus: bus, soul: mockSoul });
  role.subscribe();
  return role;
}

describe('ProfileBrowser（数据就绪后产出）', () => {
  it('profile.entered 缓存上下文 + profile.detail.arrived → emit profile.browsed 携真实 counts', () => {
    const bus = new EventBus();
    newBrowser(bus);

    let captured = null as ProfileBrowsedPayload | null;
    let count = 0;
    bus.on('profile.browsed', (p) => { captured = p; count++; });

    bus.emit('profile.entered', { authorId: 'author_123', sourcePageType: 'feed', ts: Date.now() });
    // 仅 entered 时不应产出（数据尚未就绪）
    assert.equal(count, 0, 'entered 阶段还没数据，不应 emit');

    bus.emit('profile.detail.arrived', {
      detail: { authorId: 'author_123', postsCount: 42, followersCount: 1500, extracted: true },
      ts: Date.now(),
    });

    assert.ok(captured, 'detail 到达后应 emit profile.browsed');
    assert.equal(captured!.authorId, 'author_123');
    assert.equal(captured!.sourcePageType, 'feed', 'sourcePageType 应来自缓存的 entered');
    assert.equal(captured!.postsCount, 42);
    assert.equal(captured!.followersCount, 1500);
    assert.equal(captured!.extracted, true);
  });

  it('抽取失败（extracted=false）透传，counts 不再被静默当作真 0', () => {
    const bus = new EventBus();
    newBrowser(bus);

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', { authorId: 'author_x', sourcePageType: 'search', ts: Date.now() });
    bus.emit('profile.detail.arrived', {
      detail: { authorId: 'author_x', postsCount: 0, followersCount: 0, extracted: false },
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');
    assert.equal(captured!.extracted, false);
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const role = newBrowser(bus);
    role.unsubscribe();

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', { authorId: 'author_123', sourcePageType: 'feed', ts: Date.now() });
    bus.emit('profile.detail.arrived', {
      detail: { authorId: 'author_123', postsCount: 1, followersCount: 1, extracted: true },
      ts: Date.now(),
    });

    assert.equal(captured, null, 'should not emit after unsubscribe');
  });

  it('隔离守卫①（account-real-nickname）：本人主页（detail.authorId === 连接 accountId）早退、不 emit profile.browsed', () => {
    const bus = new EventBus();
    newBrowser(bus);

    let count = 0;
    bus.on('profile.browsed', () => { count++; });

    bus.emit('profile.entered', { authorId: 'me-123', sourcePageType: 'feed', ts: Date.now() });
    bus.emit('profile.detail.arrived', {
      detail: { authorId: 'me-123', postsCount: 0, followersCount: 0, extracted: false, nickname: '工程师大白' },
      accountId: 'me-123', // 本人：authorId === accountId
      ts: Date.now(),
    });

    assert.equal(count, 0, '本人主页绝不进社交管线：不 emit profile.browsed');
  });

  it('隔离守卫①回归：他人主页（带 accountId 但 authorId ≠ accountId）仍 emit profile.browsed', () => {
    const bus = new EventBus();
    newBrowser(bus);

    let captured = null as ProfileBrowsedPayload | null;
    bus.on('profile.browsed', (p) => { captured = p; });

    bus.emit('profile.entered', { authorId: 'other-456', sourcePageType: 'feed', ts: Date.now() });
    bus.emit('profile.detail.arrived', {
      detail: { authorId: 'other-456', postsCount: 5, followersCount: 200, extracted: true },
      accountId: 'me-123', // 连接是本人 me-123，浏览的是 other-456
      ts: Date.now(),
    });

    assert.ok(captured, '他人主页正常 emit（无回归）');
    assert.equal(captured!.authorId, 'other-456');
    assert.equal(captured!.followersCount, 200);
  });
});
