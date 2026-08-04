/**
 * AC-PANEL-UPSTREAM-* 跨进程失败 MUST 在面板那一层带名字出去。
 *
 * 2026-08-04 切流当天实测的形态：管理后台上「对面进程没起」「对面没有这条路由」
 * 「本进程自己炸了」三件事**完全同形** —— 都是 500 `internal_error`，原因只留在进程日志里，
 * 判因只能上机器翻日志。
 *
 * 本组钉两件事：① 认得出的跨进程失败要变成具名 503；② **认不出的绝不折进已有名字**
 * （跨层翻译不得有兜底桶：折一次，一个「我不知道」就变成了一句「对面没起」的断言）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  isInternalHttpFailure,
  upstreamFailureReason,
} from '../../src/panel/panel-server.js';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'panel', 'panel-server.ts'),
  'utf8',
);

// **按引用取被测的那两个纯函数**（它们为此显式导出）：
// 抄一份判定到用例里，测的就只是那份抄件，而抄件永远是绿的。
const harness = {
  isInternalHttpFailure,
  upstreamFailureReason,
};

test('AC-PANEL-UPSTREAM-01 判别只看 name 与非空 code，不看 message、不用 instanceof', () => {
  // 跨进程反序列化出来的是裸对象：没有原型链，message 也不可枚举 ⇒ 两者都不能当判据。
  assert.equal(harness.isInternalHttpFailure({ name: 'InternalHttpError', code: 'timeout' }), true);
  assert.equal(harness.isInternalHttpFailure({ name: 'InternalHttpError', code: '' }), false);
  assert.equal(harness.isInternalHttpFailure({ name: 'InternalHttpError' }), false);
  assert.equal(harness.isInternalHttpFailure({ name: 'Error', code: 'timeout' }), false);
  assert.equal(harness.isInternalHttpFailure(new Error('boom')), false);
  assert.equal(harness.isInternalHttpFailure(null), false);
  assert.equal(harness.isInternalHttpFailure('timeout'), false);
});

test('AC-PANEL-UPSTREAM-02 三类可区分：不可达 / 没有这条路由 / 被拒', () => {
  assert.equal(harness.upstreamFailureReason('transport_error'), 'upstream_unreachable');
  assert.equal(harness.upstreamFailureReason('route_not_found'), 'upstream_route_missing');
  assert.equal(
    harness.upstreamFailureReason('internal_http_unauthorized'),
    'upstream_unauthorized',
  );
  // 三者互不相同 —— 这正是切流当天缺的那件事。
  const reasons = [
    harness.upstreamFailureReason('transport_error'),
    harness.upstreamFailureReason('route_not_found'),
    harness.upstreamFailureReason('internal_http_unauthorized'),
    harness.upstreamFailureReason('timeout'),
  ];
  assert.equal(new Set(reasons).size, reasons.length);
});

test('AC-PANEL-UPSTREAM-03 认不出的 MUST 返回 null，绝不折进已有名字', () => {
  for (const code of ['handler_error', 'method_not_allowed', '42P01', 'whatever_new_code']) {
    assert.equal(
      harness.upstreamFailureReason(code),
      null,
      `${code} 被映射成了某个具名原因 —— 那是把「我不知道」谎报成一句断言`,
    );
  }
});

test('AC-PANEL-UPSTREAM-04 顶层 catch 里，未识别的跨进程失败仍是 500 且具名留痕', () => {
  assert.match(
    SOURCE,
    /sendJson\(res, 500, \{ error: 'internal_error', reason: 'unclassified_upstream_error' \}\)/,
  );
  assert.match(SOURCE, /sendJson\(res, 503, \{ error: 'unavailable', reason \}\)/);
});
