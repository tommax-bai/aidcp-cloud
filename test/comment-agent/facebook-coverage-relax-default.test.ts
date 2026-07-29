import { test } from 'node:test';
import assert from 'node:assert/strict';

import { facebookCoverageRelaxEnabled } from '../../src/comment-agent/facebook-group-store.js';

// ── change default-facebook-coverage-timing-to-strict ──
//
// 放开时限兜底在账号所有群都不合规时丢掉预热、冷却与单群冷却三道闸——它在最需要这些闸的时刻把闸关掉。
// 本组用例把「默认严格」钉在代码里：在此之前该默认只活在服务器上的运行时配置文件里，
// 而那个文件不进版本库、部署时被排除、仓库里也没有模板，因此换机 / 重建 / 恢复旧备份都会让它静默回到放开。

test('默认严格：未配置时不放开', () => {
  assert.equal(facebookCoverageRelaxEnabled(undefined), false);
  assert.equal(facebookCoverageRelaxEnabled(null), false);
});

test('默认严格：配成空串或空白时不放开', () => {
  assert.equal(facebookCoverageRelaxEnabled(''), false);
  assert.equal(facebookCoverageRelaxEnabled('   '), false);
});

test('默认严格：取值拼错时不放开（失败方向收紧，不再是宽松）', () => {
  // 这几个是真实会手滑写出来的形态。旧判据 `!== 'false'` 会把它们全部当成「放开」，
  // 一个拼错的值就能静默把预热与冷却关掉；新判据一律归入严格侧。
  for (const raw of ['ture', 'True', 'TRUE', 'yes', 'on', '1', 'enabled', 'flase', 'False']) {
    assert.equal(facebookCoverageRelaxEnabled(raw), false, `${raw} MUST NOT 被当成放开`);
  }
});

test('只有显式写成 true 才放开', () => {
  assert.equal(facebookCoverageRelaxEnabled('true'), true);
});

test('显式写成 false 仍为严格（dev 现存那一行改后必须仍然成立）', () => {
  assert.equal(facebookCoverageRelaxEnabled('false'), false);
});
