import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';

interface TestFields {
  a: string;
  b: number;
  c: boolean;
}

describe('PipelineContext', () => {
  test('write 写入后 get 能读到值', () => {
    const ctx = new PipelineContext<TestFields>();
    ctx.write('a', 'hello');
    assert.equal(ctx.get('a'), 'hello');
  });

  test('get 未写入的字段返回 undefined', () => {
    const ctx = new PipelineContext<TestFields>();
    assert.equal(ctx.get('a'), undefined);
  });

  test('watch 注册后，write 触发回调', () => {
    const ctx = new PipelineContext<TestFields>();
    let received: string | undefined;
    ctx.watch('a', (value) => { received = value; });
    ctx.write('a', 'world');
    assert.equal(received, 'world');
  });

  test('watch 的 once 模式只触发一次', () => {
    const ctx = new PipelineContext<TestFields>();
    let count = 0;
    ctx.watch('a', () => { count++; }, { once: true });
    ctx.write('a', 'first');
    ctx.write('a', 'second');
    assert.equal(count, 1);
  });

  test('字段已有值时 watch 立即触发', () => {
    const ctx = new PipelineContext<TestFields>();
    ctx.write('a', 'pre-existing');
    let received: string | undefined;
    ctx.watch('a', (value) => { received = value; });
    assert.equal(received, 'pre-existing');
  });

  test('watchAll AND 条件：两个字段都写入后才触发', () => {
    const ctx = new PipelineContext<TestFields>();
    let triggered = false;
    let receivedValues: Partial<TestFields> | undefined;
    ctx.watchAll(['a', 'b'], (values) => {
      triggered = true;
      receivedValues = values;
    });
    ctx.write('a', 'hello');
    assert.equal(triggered, false);
    ctx.write('b', 42);
    assert.equal(triggered, true);
    assert.deepEqual(receivedValues, { a: 'hello', b: 42 });
  });

  test('watchAll 部分写入不触发', () => {
    const ctx = new PipelineContext<TestFields>();
    let triggered = false;
    ctx.watchAll(['a', 'b'], () => { triggered = true; });
    ctx.write('a', 'only-a');
    assert.equal(triggered, false);
  });

  test('waitFor 返回 Promise，write 后 resolve', async () => {
    const ctx = new PipelineContext<TestFields>();
    const promise = ctx.waitFor('a');
    ctx.write('a', 'resolved');
    const result = await promise;
    assert.equal(result, 'resolved');
  });

  test('waitFor 字段已有值时立即 resolve', async () => {
    const ctx = new PipelineContext<TestFields>();
    ctx.write('b', 99);
    const result = await ctx.waitFor('b');
    assert.equal(result, 99);
  });

  test('waitFor 超时 reject', async () => {
    const ctx = new PipelineContext<TestFields>();
    await assert.rejects(
      () => ctx.waitFor('a', 50),
      (err: Error) => {
        assert.match(err.message, /timed out/);
        return true;
      }
    );
  });

  test('handler 异常不阻塞其他 watcher', () => {
    const ctx = new PipelineContext<TestFields>();
    let secondCalled = false;
    ctx.watch('a', () => { throw new Error('boom'); });
    ctx.watch('a', () => { secondCalled = true; });
    ctx.write('a', 'test');
    assert.equal(secondCalled, true);
  });

  test('reset 清空所有状态和 watchers', () => {
    const ctx = new PipelineContext<TestFields>();
    ctx.write('a', 'val');
    let called = false;
    ctx.watch('b', () => { called = true; });
    ctx.reset();
    assert.equal(ctx.get('a'), undefined);
    ctx.write('b', 1);
    assert.equal(called, false);
  });

  test('snapshot 返回当前状态副本', () => {
    const ctx = new PipelineContext<TestFields>();
    ctx.write('a', 'x');
    ctx.write('b', 10);
    const snap = ctx.snapshot();
    assert.deepEqual(snap, { a: 'x', b: 10 });
    // 修改 snapshot 不影响原始状态
    (snap as any).a = 'modified';
    assert.equal(ctx.get('a'), 'x');
  });

  test('unsubscribe 取消 watch 后不再触发', () => {
    const ctx = new PipelineContext<TestFields>();
    let count = 0;
    const unsub = ctx.watch('a', () => { count++; });
    ctx.write('a', 'first');
    assert.equal(count, 1);
    unsub();
    ctx.write('a', 'second');
    assert.equal(count, 1);
  });
});
