import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { FollowAgent } from '../../src/agents/follow-agent.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { ProfileDonePayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

describe('FollowAgent', () => {
  it('构造函数：无 LLM 抛错', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    assert.throws(
      () => new FollowAgent({
        eventBus: bus,
        soul: mockSoul,
        sessionContext: ctx,
        getRemainingFollows: () => 3,
      }),
      /需要 LlmClient/,
    );
  });

  it('LLM 返回 follow → emit profile.done(followed=true)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"follow","reason":"内容持续高质量","confidence":0.85}',
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 3,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_123',
      sourcePageType: 'feed',
      postsCount: 50,
      followersCount: 2000,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit profile.done');
    assert.equal(captured!.authorId, 'author_123');
    assert.equal(captured!.followed, true);
    assert.equal(captured!.sourcePageType, 'feed');

    role.unsubscribe();
  });

  it('prompt 不含"作品数"、含获赞与收藏；postsCount=0 但粉丝/获赞健康 → 能 follow（live skip bug 回归）', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let captured = '';
    const llm = {
      complete: async (p: string) => {
        captured = p;
        return '{"verdict":"follow","reason":"主题相关且受众健康","confidence":0.8}';
      },
    };
    const role = new FollowAgent({ eventBus: bus, soul: mockSoul, llm, sessionContext: ctx, getRemainingFollows: () => 3 });
    role.subscribe();
    let done = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { done = p; });

    // 复刻 live：小红书主页不提供作品数（postsCount=0），但粉丝 130 / 获赞与收藏 6707 健康。
    bus.emit('profile.browsed', {
      authorId: 'author_x', sourcePageType: 'feed',
      postsCount: 0, followersCount: 130, likesCollects: 6707, extracted: true, ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!captured.includes('作品数'), `prompt 不应再出现"作品数"项，实际:\n${captured}`);
    assert.match(captured, /获赞与收藏：6707/, 'prompt 应含获赞与收藏真实值');
    assert.match(captured, /粉丝数：130/);
    assert.ok(done && done.followed === true, 'postsCount=0 但粉丝/获赞健康 + 相关 → 应能 follow，而非以作品数未知 skip');

    role.unsubscribe();
  });

  it('LLM 返回 skip → emit profile.done(followed=false)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"skip","reason":"作品太少"}',
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 3,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_456',
      sourcePageType: 'search',
      postsCount: 2,
      followersCount: 50,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.followed, false);
    assert.equal(captured!.sourcePageType, 'search');

    role.unsubscribe();
  });

  it('资料未抽取(extracted=false) → 保守 skip 且不调用 LLM（不当作真 0 粉丝）', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let llmCalled = false;
    const llm = {
      complete: async () => { llmCalled = true; return '{"verdict":"follow","reason":"test"}'; },
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 3,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_no_data',
      sourcePageType: 'feed',
      postsCount: 0,
      followersCount: 0,
      extracted: false,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.followed, false);
    assert.equal(llmCalled, false, 'extracted=false 时不应调用 LLM');

    role.unsubscribe();
  });

  it('配额耗尽 → emit profile.done(followed=false) 不调用 LLM', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let llmCalled = false;
    const llm = {
      complete: async () => { llmCalled = true; return '{"verdict":"follow","reason":"test"}'; },
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 0,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_789',
      sourcePageType: 'feed',
      postsCount: 100,
      followersCount: 5000,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.followed, false);
    assert.equal(llmCalled, false, 'LLM should not be called when quota exhausted');

    role.unsubscribe();
  });

  it('LLM 抛错 → emit profile.done(followed=false)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => { throw new Error('timeout'); } };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 3,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_err',
      sourcePageType: 'feed',
      postsCount: 30,
      followersCount: 800,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.followed, false);

    role.unsubscribe();
  });

  it('sourcePageType 透传正确', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"follow","reason":"好博主","confidence":0.9}',
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 5,
    });
    role.subscribe();

    let captured = null as ProfileDonePayload | null;
    bus.on('profile.done', (p) => { captured = p; });

    bus.emit('profile.browsed', {
      authorId: 'author_search',
      sourcePageType: 'search',
      postsCount: 60,
      followersCount: 3000,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"follow","reason":"test","confidence":0.8}',
    };
    const role = new FollowAgent({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getRemainingFollows: () => 3,
    });
    role.subscribe();
    role.unsubscribe();

    let emitted = false;
    bus.on('profile.done', () => { emitted = true; });

    bus.emit('profile.browsed', {
      authorId: 'author_123',
      sourcePageType: 'feed',
      postsCount: 20,
      followersCount: 500,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(emitted, false);
  });
});
