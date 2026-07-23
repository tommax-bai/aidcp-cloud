import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSoulFromYaml, serializeSoul } from '../src/soul/index.js';
import type { Soul } from '../src/kernel/soul-types.js';

const baseSoul: Soul = {
  identity: { name: 'Minh Anh', role: 'người tìm việc', background: 'Tìm việc tại Việt Nam', tone: 'thân thiện' },
  interests: { primary: ['tuyển dụng'], secondary: [], seed_keywords: ['cần tuyển'] },
  mandatory_interactions: [{
    id: 'vietnam-recruitment',
    when: 'Bài đăng tuyển dụng hoặc tuyển người tại Việt Nam',
    actions: ['like', 'comment'],
    comment_guidance: 'Bình luận bằng tiếng Việt và hỏi một chi tiết công việc.',
    comment_approval: 'auto_approve',
  }],
};

describe('mandatory_interactions persona schema', () => {
  it('合法规则 serialize → load round-trip 不丢站立授权', () => {
    const yaml = serializeSoul(baseSoul);
    const loaded = loadSoulFromYaml(yaml);
    assert.deepEqual(loaded.mandatory_interactions, baseSoul.mandatory_interactions);
    assert.match(yaml, /mandatory_interactions:/);
    assert.match(yaml, /comment_approval: "auto_approve"/);
  });

  it('未配置规则保持 undefined（不从自由文本猜授权）', () => {
    const { mandatory_interactions: _ignored, ...plain } = baseSoul;
    const loaded = loadSoulFromYaml(serializeSoul(plain));
    assert.equal(loaded.mandatory_interactions, undefined);
  });

  it('comment 未同时包含 like → 整份拒绝', () => {
    const yaml = serializeSoul({
      ...baseSoul,
      mandatory_interactions: [{
        ...baseSoul.mandatory_interactions![0],
        actions: ['comment'],
      }],
    });
    assert.throws(() => loadSoulFromYaml(yaml), /同时含 like/);
  });

  it('重复 id / 未知动作 / 缺评论指引均拒绝', () => {
    const valid = baseSoul.mandatory_interactions![0];
    assert.throws(() => loadSoulFromYaml(serializeSoul({
      ...baseSoul,
      mandatory_interactions: [valid, { ...valid }],
    })), /id 重复/);

    const unknownActionYaml = serializeSoul(baseSoul).replace('      - "comment"', '      - "share"');
    assert.throws(() => loadSoulFromYaml(unknownActionYaml), /只允许 like\/comment/);

    const missingGuidanceYaml = serializeSoul(baseSoul).replace(/    comment_guidance:.*\n/, '');
    assert.throws(() => loadSoulFromYaml(missingGuidanceYaml), /comment_guidance/);
  });
});
