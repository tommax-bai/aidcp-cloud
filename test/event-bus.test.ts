import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus/index.js';

describe('EventBus', () => {
  it('on + emit：注册 handler，emit 后 handler 被调用，接收正确数据', () => {
    const bus = new EventBus();
    let received: unknown = null;
    bus.on('note.arrived', (data) => { received = data; });
    const payload = { note: { noteId: 'n1', title: 'T', summary: 'S', likeCount: 10, collectCount: 5 }, ts: 1000 };
    bus.emit('note.arrived', payload);
    assert.deepEqual(received, payload);
  });

  it('once：handler 只触发一次', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('blackboard.updated', () => { count++; });
    bus.emit('blackboard.updated', { field: 'a' });
    bus.emit('blackboard.updated', { field: 'b' });
    assert.equal(count, 1);
  });

  it('off：取消注册后不再触发', () => {
    const bus = new EventBus();
    let count = 0;
    const handler = () => { count++; };
    bus.on('blackboard.updated', handler);
    bus.emit('blackboard.updated', { field: 'x' });
    assert.equal(count, 1);
    bus.off('blackboard.updated', handler);
    bus.emit('blackboard.updated', { field: 'y' });
    assert.equal(count, 1);
  });

  it('on 返回的 unsubscribe 函数能正确取消', () => {
    const bus = new EventBus();
    let count = 0;
    const unsub = bus.on('blackboard.updated', () => { count++; });
    bus.emit('blackboard.updated', { field: 'a' });
    assert.equal(count, 1);
    unsub();
    bus.emit('blackboard.updated', { field: 'b' });
    assert.equal(count, 1);
  });

  it('emitAsync：等待所有 async handler resolve', async () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.on('blackboard.updated', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    bus.on('blackboard.updated', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
    });
    await bus.emitAsync('blackboard.updated', { field: 'test' });
    // 两个 handler 都已完成
    assert.equal(order.length, 2);
    assert.ok(order.includes(1));
    assert.ok(order.includes(2));
  });

  it('onAny：wildcard 监听能捕获所有事件', () => {
    const bus = new EventBus();
    const captured: { event: string; data: unknown }[] = [];
    bus.onAny((event, data) => { captured.push({ event, data }); });
    bus.emit('blackboard.updated', { field: 'f1' });
    bus.emit('note.arrived', { note: { noteId: 'n1', title: 'T', summary: 'S', likeCount: 0, collectCount: 0 }, ts: 0 });
    assert.equal(captured.length, 2);
    assert.equal(captured[0].event, 'blackboard.updated');
    assert.equal(captured[1].event, 'note.arrived');
  });

  it('removeAllListeners：清空后不再触发', () => {
    const bus = new EventBus();
    let count = 0;
    let wildcardCount = 0;
    bus.on('blackboard.updated', () => { count++; });
    bus.onAny(() => { wildcardCount++; });
    bus.emit('blackboard.updated', { field: 'x' });
    assert.equal(count, 1);
    assert.equal(wildcardCount, 1);
    bus.removeAllListeners();
    bus.emit('blackboard.updated', { field: 'y' });
    assert.equal(count, 1);
    assert.equal(wildcardCount, 1);
  });

  it('错误隔离：一个 handler 抛错不影响其他 handler', () => {
    const bus = new EventBus();
    let called = false;
    bus.on('blackboard.updated', () => { throw new Error('boom'); });
    bus.on('blackboard.updated', () => { called = true; });
    bus.emit('blackboard.updated', { field: 'x' });
    assert.equal(called, true);
  });
});
