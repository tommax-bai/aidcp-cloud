/**
 * 副本陈旧时出口闸的放行判定（kernel）。
 *
 * 这一段的失手形态是**单向的**：多扣住一类信封不会报错，只会让一个本可自愈的阻塞变成死锁
 * ——租约归还发不出去 ⇒ 浏览器槽位永不释放；而调用方只看到「投递 0 个」，
 * 把在线的边缘误报成离线。所以名单里每一条都要有用例钉着。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allowsTransportWhenGateUnknown,
  TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN,
} from '../src/kernel/transport-gate-exemptions.js';

test('租约取得与归还成对放行（只放行一头会一边堵一边通）', () => {
  assert.equal(allowsTransportWhenGateUnknown('edge.task.acquire', null), true);
  assert.equal(
    allowsTransportWhenGateUnknown('edge.task.release', null),
    true,
    '归还被扣住 = 浏览器槽位永不释放，这是把可自愈的阻塞做成死锁',
  );
});

test('验证码协助与详情页收尾照常放行', () => {
  for (const type of ['captcha.assist.capture', 'captcha.assist.click', 'note.close', 'navigation.back']) {
    assert.equal(allowsTransportWhenGateUnknown(type, null), true, type);
  }
});

test('控制面与浏览器生命周期照常放行，真实平台动作与页面自动化不放行', () => {
  assert.equal(allowsTransportWhenGateUnknown('anything.else', 'automation_control'), true);
  assert.equal(allowsTransportWhenGateUnknown('anything.else', 'browser_lifecycle'), true);
  assert.equal(
    allowsTransportWhenGateUnknown('interaction.like', 'platform_api_automation'),
    false,
    '停手的定义就是不放行**新的真实平台动作**；这一条放行了停手闸就等于没有',
  );
  assert.equal(allowsTransportWhenGateUnknown('page.scroll', 'page_automation'), false);
  assert.equal(allowsTransportWhenGateUnknown('unknown.type', null), false);
});

test('豁免名单只有那几条：它是「不放行会死锁」的清单，不是「重要的」清单', () => {
  assert.deepEqual(
    [...TRANSPORT_EXEMPT_WHEN_MIRROR_UNKNOWN],
    [
      'edge.task.acquire',
      'edge.task.release',
      'captcha.assist.capture',
      'captcha.assist.click',
      'note.close',
      'navigation.back',
    ],
    '名单越长，停手闸能停住的东西越少。新增成员 MUST 按「扣住它会造成死锁」这条判据说明理由',
  );
});
