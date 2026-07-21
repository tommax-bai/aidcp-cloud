import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  facebookPostKey,
  hasObviousHighRiskFacebookCaption,
  isCanonicalFacebookFeedVideoNoteId,
  isCanonicalFacebookReelNoteId,
} from '../src/platform/facebook-presented-video.js';

test('facebook presented video: watch identity is normalized and surface validators stay disjoint', () => {
  const watch = 'https://www.facebook.com/watch?v=1632570071375207';
  const reel = 'https://www.facebook.com/reel/1632570071375207';
  assert.equal(facebookPostKey(watch), '1632570071375207');
  assert.equal(isCanonicalFacebookFeedVideoNoteId(watch), true);
  assert.equal(isCanonicalFacebookReelNoteId(watch), false);
  assert.equal(isCanonicalFacebookFeedVideoNoteId(reel), false);
  assert.equal(isCanonicalFacebookReelNoteId(reel), true);
});

test('facebook Feed video identity: normalized post/video forms pass; tracking, foreign and malformed forms fail', () => {
  for (const valid of [
    'https://www.facebook.com/watch?v=42',
    'https://www.facebook.com/Meta/videos/42',
    'https://www.facebook.com/Meta/posts/pfbid0ABC',
    'https://www.facebook.com/groups/7?multi_permalinks=42',
    'https://www.facebook.com/permalink.php?story_fbid=42&id=7',
  ]) assert.equal(isCanonicalFacebookFeedVideoNoteId(valid), true, valid);

  for (const invalid of [
    'https://evil.example/watch?v=42',
    'http://www.facebook.com/watch?v=42',
    'https://www.facebook.com/watch?v=42&tracking=x',
    'https://www.facebook.com/watch?v=abc',
    'https://www.facebook.com/reel/42',
    'javascript:void(0)',
  ]) assert.equal(isCanonicalFacebookFeedVideoNoteId(invalid), false, invalid);
});

test('facebook Feed video caption guard: ordinary travel/cooking text passes; explicit graphic/gambling terms abstain', () => {
  assert.equal(hasObviousHighRiskFacebookCaption('Mở mắt thấy biển khơi 🌊💗'), false);
  assert.equal(hasObviousHighRiskFacebookCaption('Cách nấu cá niêng trong ống tre ngon đến mức ăn quên no'), false);
  assert.equal(hasObviousHighRiskFacebookCaption('casino gambling highlights'), true);
  assert.equal(hasObviousHighRiskFacebookCaption('clip chặt đầu máu me'), true);
  assert.equal(hasObviousHighRiskFacebookCaption('内容涉及赌博'), true);
});
