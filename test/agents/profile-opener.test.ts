import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ProfileOpener } from '../../src/agents/profile-opener.js';
import type { Soul } from '../../src/soul/types.js';
import type { ProfileEnteredPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

describe('ProfileOpener', () => {
  it('收到 profile.worth_visiting → emit profile.entered', () => {
    const bus = new EventBus();
    const role = new ProfileOpener({ eventBus: bus, soul: mockSoul });
    role.subscribe();

    let captured = null as ProfileEnteredPayload | null;
    bus.on('profile.entered', (p) => { captured = p; });

    bus.emit('profile.worth_visiting', {
      noteId: 'note_1',
      authorId: 'author_123',
      sourcePageType: 'feed',
      reason: '作者专业',
      ts: Date.now(),
    });

    assert.ok(captured, 'should emit profile.entered');
    assert.equal(captured!.authorId, 'author_123');
    assert.equal(captured!.sourcePageType, 'feed');
  });

  it('sourcePageType=search → profile.entered.sourcePageType=search', () => {
    const bus = new EventBus();
    const role = new ProfileOpener({ eventBus: bus, soul: mockSoul });
    role.subscribe();

    let captured = null as ProfileEnteredPayload | null;
    bus.on('profile.entered', (p) => { captured = p; });

    bus.emit('profile.worth_visiting', {
      noteId: 'note_2',
      authorId: 'author_456',
      sourcePageType: 'search',
      reason: '搜索发现的优质作者',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');
    assert.equal(captured!.authorId, 'author_456');
  });

  it('透传 authorId', () => {
    const bus = new EventBus();
    const role = new ProfileOpener({ eventBus: bus, soul: mockSoul });
    role.subscribe();

    let captured = null as ProfileEnteredPayload | null;
    bus.on('profile.entered', (p) => { captured = p; });

    bus.emit('profile.worth_visiting', {
      noteId: 'note_3',
      authorId: 'special_author',
      sourcePageType: 'feed',
      reason: '高质量内容',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.authorId, 'special_author');
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const role = new ProfileOpener({ eventBus: bus, soul: mockSoul });
    role.subscribe();
    role.unsubscribe();

    let captured = null as ProfileEnteredPayload | null;
    bus.on('profile.entered', (p) => { captured = p; });

    bus.emit('profile.worth_visiting', {
      noteId: 'note_1',
      authorId: 'author_123',
      sourcePageType: 'feed',
      reason: 'test',
      ts: Date.now(),
    });

    assert.equal(captured, null, 'should not emit after unsubscribe');
  });
});
