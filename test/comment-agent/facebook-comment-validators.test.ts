import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFacebookComment,
  type FacebookCommentRejectReason,
} from '../../src/comment-agent/facebook-comment-validators.js';

function reject(text: string, ctx = {}): FacebookCommentRejectReason {
  const r = validateFacebookComment(text, ctx);
  assert.equal(r.ok, false, `expected rejection for: ${JSON.stringify(text)}`);
  return (r as { ok: false; reason: FacebookCommentRejectReason }).reason;
}

describe('validateFacebookComment: reject matrix (facebook-scheduled-comment 3.2/3.3)', () => {
  it('empty / whitespace-only → empty', () => {
    assert.equal(reject(''), 'empty');
    assert.equal(reject('   \n  '), 'empty');
    assert.equal(validateFacebookComment(null).ok, false);
    assert.equal(validateFacebookComment(undefined).ok, false);
  });

  it('punctuation / emoji only → low_signal', () => {
    assert.equal(reject('!!!???'), 'low_signal');
    assert.equal(reject('😀🎉🔥'), 'low_signal');
    assert.equal(reject('。。。'), 'low_signal');
  });

  it('single signal char → too_short (below min)', () => {
    assert.equal(reject('好'), 'too_short');
    assert.equal(reject('a'), 'too_short');
  });

  it('over length → too_long', () => {
    assert.equal(reject('x'.repeat(2000), { maxLength: 500 }), 'too_long');
    // custom short cap
    assert.equal(reject('这是一条略长的评论内容', { maxLength: 5 }), 'too_long');
  });

  it('URLs and bare domains → contains_url', () => {
    assert.equal(reject('看看这个 https://spam.example/x'), 'contains_url');
    assert.equal(reject('visit www.example.com now'), 'contains_url');
    assert.equal(reject('去 example.shop 买'), 'contains_url');
    assert.equal(reject('go to bit.ly/abc'), 'contains_url');
  });

  it('contact info (email / phone / IM) → contains_contact', () => {
    assert.equal(reject('联系 me@spam.com'), 'contains_url'); // email 含域名，URL 先命中（仍拒绝，安全）
    assert.equal(reject('call 138 1234 5678 today'), 'contains_contact');
    assert.equal(reject('加微信 detail'), 'contains_contact');
    assert.equal(reject('add me on telegram'), 'contains_contact');
    assert.equal(reject('私聊我了解'), 'contains_contact');
  });

  it('@ mentions → contains_mention', () => {
    assert.equal(reject('great post @someone'), 'contains_mention');
    assert.equal(reject('同意 @张三 说的'), 'contains_mention');
  });

  it('spam / marketing phrases → spam_phrase', () => {
    assert.equal(reject('nice, click here to win'), 'spam_phrase');
    assert.equal(reject('buy now while stock lasts'), 'spam_phrase');
    assert.equal(reject('follow me for more tips'), 'spam_phrase');
    // 'dm me' / '加微信' 同时命中联系方式正则，且联系方式闸更靠前 → contains_contact（仍拒绝，安全）
    assert.equal(reject('great content, dm me for details'), 'contains_contact');
    assert.equal(reject('好内容，加微信详聊'), 'contains_contact');
    assert.equal(reject('这个必须点击链接看'), 'spam_phrase');
    assert.equal(reject('限时优惠不要错过'), 'spam_phrase');
  });

  it('weak relevance only when target keywords provided and zero overlap → weak_relevance', () => {
    // 零重叠 → 拒
    assert.equal(
      reject('完全无关的随口一句评论', { targetKeywords: ['咖啡', '手冲', '烘焙'] }),
      'weak_relevance',
    );
    // 有重叠 → 通过
    const ok = validateFacebookComment('这家手冲咖啡真不错', { targetKeywords: ['手冲', '咖啡'] });
    assert.equal(ok.ok, true);
    // 不提供关键词 → 不判相关性（通过）
    const ok2 = validateFacebookComment('随便说一句真实感受', {});
    assert.equal(ok2.ok, true);
  });

  it('valid natural comments pass and text is returned untouched (trim only, no repair)', () => {
    const r = validateFacebookComment('  写得很有共鸣，感谢分享  ');
    assert.equal(r.ok, true);
    assert.equal((r as { ok: true; text: string }).text, '写得很有共鸣，感谢分享');
    assert.equal(validateFacebookComment('Totally agree, well said').ok, true);
  });

  it('does NOT auto-fix: a rejected text never comes back ok with modified content', () => {
    // 含链接的文本被拒，绝不返回「剥掉链接后的可发文本」
    const r = validateFacebookComment('好文 https://x.example/y 推荐');
    assert.equal(r.ok, false);
    assert.ok(!('text' in r), '拒绝结果不得携带可发文本（只拒不修）');
  });
});
