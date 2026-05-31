import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFingerprint, SCHEMA_SQL, DEFAULT_PG_CONFIG } from '../src/cache/index.js';
import type { RemoteAnchor } from '../src/comm/index.js';

// 纯函数 / 常量层面的单测（不连真实 PG；连接型行为留待集成测试）。

test('anchorFingerprint 忽略统计字段，定位指纹一致即相等', () => {
  const a: RemoteAnchor = { actionId: 'like', role: 'button', text: '点赞', textMatch: 'contains' };
  const b: RemoteAnchor = { actionId: 'like', role: 'button', text: '点赞' }; // textMatch 默认 contains
  assert.equal(anchorFingerprint(a), anchorFingerprint(b));
});

test('anchorFingerprint 文本不同 → 指纹不同', () => {
  const a: RemoteAnchor = { actionId: 'like', role: 'button', text: '点赞' };
  const b: RemoteAnchor = { actionId: 'like', role: 'button', text: '赞' };
  assert.notEqual(anchorFingerprint(a), anchorFingerprint(b));
});

test('默认 PG 配置指向本机 aidcp 库', () => {
  assert.equal(DEFAULT_PG_CONFIG.host, '127.0.0.1');
  assert.equal(DEFAULT_PG_CONFIG.port, 5432);
  assert.equal(DEFAULT_PG_CONFIG.database, 'aidcp');
  assert.equal(DEFAULT_PG_CONFIG.user, 'aidcp');
});

test('SCHEMA_SQL 含主缓存表与暂存表', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS anchors/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS anchor_staging/);
});
