import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDelegatedTaskServiceError } from '../../src/kernel/operator-command-port.js';
import { DelegatedTaskServiceError } from '../../src/kernel/delegated-task-types.js';
import {
  CURATED_CONTENT_UNAVAILABLE_ERROR_CODE,
  CuratedContentUnavailableError,
  curatedContentFailureReason,
  isCuratedContentUnavailableError,
} from '../../src/kernel/curated-content-types.js';

/** 跨进程那一跳后调用方拿到的东西：原型链上什么都没有的裸对象。 */
const overTheWire = (err: unknown): unknown => JSON.parse(JSON.stringify(err)) as unknown;

test('委托任务业务错误：跨进程裸对象仍认得出，且 instanceof 在同一对象上已恒 false', () => {
  const err = new DelegatedTaskServiceError('version_conflict', '卡片版本已过期', 409);
  const wire = overTheWire(err);
  assert.equal(wire instanceof DelegatedTaskServiceError, false, '前提：跨进程对象不再是本进程的类实例');
  assert.equal(isDelegatedTaskServiceError(err), true, '同进程实例');
  assert.equal(isDelegatedTaskServiceError(wire), true, '跨进程裸对象');
  assert.equal(isDelegatedTaskServiceError(wire) && wire.code, 'version_conflict', '具名拒绝原因必须活着过线');
  assert.equal(isDelegatedTaskServiceError({ name: 'DelegatedTaskServiceError' }), false, '无 code 不算可识别');
});

test('精选库不可用：跨进程裸对象仍认得出，且线上 code 随对象过线', () => {
  const err = new CuratedContentUnavailableError('listForPanel');
  const wire = overTheWire(err) as { code?: string };
  assert.equal(wire instanceof CuratedContentUnavailableError, false, '前提：跨进程对象不再是本进程的类实例');
  assert.equal(isCuratedContentUnavailableError(err), true, '同进程实例');
  assert.equal(isCuratedContentUnavailableError(wire), true, '跨进程裸对象');
  // 内部 HTTP 只搬 code + message：没有 code 的抛出物在对面一律记成 handler_error。
  assert.equal(wire.code, CURATED_CONTENT_UNAVAILABLE_ERROR_CODE);
  assert.equal(curatedContentFailureReason(wire), CURATED_CONTENT_UNAVAILABLE_ERROR_CODE);
});
