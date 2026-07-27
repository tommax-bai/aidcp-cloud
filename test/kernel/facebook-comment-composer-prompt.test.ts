import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFacebookCommentComposerPrompt } from '../../src/kernel/facebook-comment-composer-prompt.js';

test('Facebook 评论 prompt：空关键词不输出空话题要求，仍保留帖子上下文', () => {
  const prompt = buildFacebookCommentComposerPrompt({
    soul: { identity: { name: '测试账号', role: '群友', background: '社区成员', tone: '自然' } },
    writingLanguage: 'zh-CN',
    keyword: '   ',
    postText: '首帖正文',
    comments: ['首条评论'],
  });
  assert.doesNotMatch(prompt, /话题「」/);
  assert.doesNotMatch(prompt, /生硬堆砌关键词/);
  assert.match(prompt, /首帖正文/);
  assert.match(prompt, /首条评论/);
});

test('Facebook 评论 prompt：非空关键词继续保留既有相关性要求', () => {
  const prompt = buildFacebookCommentComposerPrompt({
    soul: { identity: { name: '测试账号', role: '群友', background: '社区成员', tone: '自然' } },
    writingLanguage: 'zh-CN',
    keyword: ' 咖啡 ',
  });
  assert.match(prompt, /话题「咖啡」/);
});
