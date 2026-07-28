import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideFacebookBrowseMode,
  selectFacebookRuleCard,
  stableFacebookRuleContentKey,
} from '../../src/orchestrator/facebook-rule-mode.js';

const base = {
  platform: 'facebook',
  ruleEnabled: true,
  activeWeek: true,
  personaBinding: 'bound' as const,
  slowStart: { state: 'off' },
};

describe('facebook rule mode arbitration', () => {
  it('lets active slow start win before the persona exception and rule configuration', () => {
    assert.deepEqual(
      decideFacebookBrowseMode({
        ...base,
        personaBinding: 'unbound',
        slowStart: { state: 'active' },
      }),
      { mode: 'slow_start', blocker: 'slow_start_active' },
    );
  });

  it('fails closed for unknown or conflicting slow-start identity, even for an unbound rule-mode account', () => {
    for (const ineligibleReason of [
      'binding_unknown',
      'binding_conflict',
      'platform_unknown',
      'platform_unsupported',
    ] as const) {
      assert.deepEqual(
        decideFacebookBrowseMode({
          ...base,
          personaBinding: 'unbound',
          slowStart: { state: 'off', ineligibleReason },
        }),
        { mode: 'blocked', blocker: ineligibleReason },
      );
    }
  });

  it('allows off and graduated slow start', () => {
    for (const state of ['off', 'graduated']) {
      assert.deepEqual(
        decideFacebookBrowseMode({ ...base, slowStart: { state } }),
        { mode: 'facebook_rule', blocker: null },
      );
    }
  });

  // change facebook-rule-mode-without-persona：规则模式取消绑定人设入口闸。
  it('admits an unbound account to rule mode without substituting any persona', () => {
    for (const personaBinding of ['unbound', 'unknown'] as const) {
      assert.deepEqual(
        decideFacebookBrowseMode({ ...base, personaBinding }),
        { mode: 'facebook_rule', blocker: null },
      );
    }
  });

  it('keeps the persona browse loop gated for an unbound account when rule mode is not admitted', () => {
    // 规则模式关闭 → 该账号回到人设浏览闭环，人设闸逐字不变。
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, ruleEnabled: false, personaBinding: 'unbound' }),
      { mode: 'blocked', blocker: 'no_persona' },
    );
    // 规则模式开着但不在活跃周 → 同样不是规则模式，仍不得让人设闭环空跑。
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, activeWeek: false, personaBinding: 'unbound' }),
      { mode: 'blocked', blocker: 'no_persona' },
    );
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, ruleEnabled: false, personaBinding: 'unknown' }),
      { mode: 'blocked', blocker: 'persona_unavailable' },
    );
  });

  it('returns persona mode outside an eligible enabled rule window and rejects other platforms', () => {
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, ruleEnabled: false }),
      { mode: 'persona', blocker: null },
    );
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, activeWeek: false }),
      { mode: 'persona', blocker: 'outside_active_window' },
    );
    assert.deepEqual(
      decideFacebookBrowseMode({ ...base, platform: 'xiaohongshu', personaBinding: 'unbound' }),
      { mode: 'unsupported', blocker: 'rule_mode_unsupported' },
    );
  });
});

describe('facebook rule card selection', () => {
  it('selects the first structurally safe, stable, unvisited card in feed order', () => {
    const card = selectFacebookRuleCard([
      { index: 4, noteId: 'https://www.facebook.com/posts/later', title: 'later', likeCount: 0, collectCount: 0 },
      { index: 1, noteId: undefined, title: 'placeholder', likeCount: 0, collectCount: 0 },
      { index: 2, noteId: 'https://www.facebook.com/posts/unsafe', title: 'casino gambling highlights', likeCount: 0, collectCount: 0 },
      { index: 3, noteId: 'https://www.facebook.com/posts/seen', title: 'seen', likeCount: 0, collectCount: 0 },
      { index: 0, noteId: 'https://www.facebook.com/posts/first', title: 'first', likeCount: 0, collectCount: 0 },
    ], (key) => key === 'first' || key === 'seen');

    assert.equal(card?.noteId, 'https://www.facebook.com/posts/later');
  });

  it('normalizes supported Facebook identities and rejects empty identities', () => {
    assert.equal(stableFacebookRuleContentKey('https://www.facebook.com/watch?v=123'), '123');
    assert.equal(stableFacebookRuleContentKey('feed-123'), null);
    assert.equal(stableFacebookRuleContentKey('https://evil.example/posts/123'), null);
    assert.equal(stableFacebookRuleContentKey('   '), null);
    assert.equal(stableFacebookRuleContentKey(undefined), null);
  });
});
