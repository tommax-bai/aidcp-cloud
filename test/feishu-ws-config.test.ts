import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFeishuWsEnabled } from '../src/feishu/ws-config.js';

test('feishu ws config: defaults to enabled for existing deployments', () => {
  assert.equal(isFeishuWsEnabled({}), true);
});

test('feishu ws config: only literal false disables receiver', () => {
  assert.equal(isFeishuWsEnabled({ AIDCP_FEISHU_WS_ENABLED: 'false' }), false);
  assert.equal(isFeishuWsEnabled({ AIDCP_FEISHU_WS_ENABLED: 'FALSE' }), true);
  assert.equal(isFeishuWsEnabled({ AIDCP_FEISHU_WS_ENABLED: '0' }), true);
});
