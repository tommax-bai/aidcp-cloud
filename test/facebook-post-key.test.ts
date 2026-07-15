/**
 * change facebook-natural-interaction-gate-key —— 自然互动见证两集合的 noteId 去形态匹配。
 *
 * 真机 bug：「已选中」集合(page.cards 卡形态) 与「已放行」集合(note.detail 形态) 对同一帖存的字符串不同
 * → 裸 Set 精确匹配 miss → interaction_appraiser 恒 fb_quality_not_passed、点赞被系统性挡掉。
 * facebookPostKey 归一到帖数字 id 后，同帖多形态匹配一致。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { facebookPostKey } from '../src/orchestrator/role-dispatcher.js';

describe('facebookPostKey', () => {
  it('群帖 multi_permalinks：带尾斜杠/__cft__ 追踪参数 与 干净形态 → 同一 key', () => {
    const card = 'https://www.facebook.com/groups/1413487622443607/?multi_permalinks=2579243155868042&__cft__[0]=AZxyz&__tn__=%2CO';
    const detail = 'https://www.facebook.com/groups/1413487622443607?multi_permalinks=2579243155868042';
    assert.equal(facebookPostKey(card), '2579243155868042');
    assert.equal(facebookPostKey(detail), '2579243155868042');
    assert.equal(facebookPostKey(card), facebookPostKey(detail), '同帖两形态必须归一到同一 key');
  });

  it('主页帖 /posts/P → P', () => {
    assert.equal(facebookPostKey('https://www.facebook.com/happynestvn/posts/pfbid025VPn9d?__cft__[0]=abc'), 'pfbid025VPn9d');
  });

  it('story_fbid / permalink.php → story_fbid', () => {
    assert.equal(facebookPostKey('https://www.facebook.com/permalink.php?story_fbid=99887766&id=100064'), '99887766');
  });

  it('videos / reel → 帖 id', () => {
    assert.equal(facebookPostKey('https://www.facebook.com/reel/1234567890'), '1234567890');
    assert.equal(facebookPostKey('https://www.facebook.com/watch/videos/9876543210'), '9876543210');
  });

  it('派生不出（未知形态）→ 回退原字符串，绝不合并未知帖', () => {
    const weird = 'https://www.facebook.com/some/unknown/path';
    assert.equal(facebookPostKey(weird), weird);
    // 两个不同的未知帖不会被误判成同一 key
    assert.notEqual(facebookPostKey('https://www.facebook.com/a/x'), facebookPostKey('https://www.facebook.com/b/y'));
  });

  it('空/undefined → 空串（不抛）', () => {
    assert.equal(facebookPostKey(''), '');
    assert.equal(facebookPostKey(undefined), '');
    assert.equal(facebookPostKey(null), '');
  });
});
