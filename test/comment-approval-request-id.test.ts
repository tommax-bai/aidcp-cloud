import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import {
  buildCommentApprovalRequestId,
  sanitizeApprovalRequestSegment,
} from '@automation/agents/comment-approval-request-id.js';
import { getApprovalSignalPath } from '@api/feishu/ws-receiver.js';

// 面板 web 审批路由的 requestId 白名单（panel-server.ts:1085），与信号落盘安全同源。
const PANEL_WHITELIST = /^[A-Za-z0-9_-]+$/;

test('FB 帖子 URL noteId → requestId 恒为文件系统安全字符集（回归：thekdaily ENOENT）', () => {
  // 生产日志实测的失败 URL（Kdaily 韓粉日常 / 李星民 那张卡）。
  const fbUrl =
    'https://www.facebook.com/thekdaily/posts/pfbid02LVoF6tf4Y1AKr5ha9tMH57EEbWEWdtADUait7yLxEsEAxyXnSoWdZsi61MjnQqHSl';
  const requestId = buildCommentApprovalRequestId(fbUrl, 1784119444231);

  // 归一后无路径分隔符 / 白名单外字符。
  assert.match(requestId, PANEL_WHITELIST);
  assert.ok(!requestId.includes('/'), '不得含 /');
  assert.ok(!requestId.includes(':'), '不得含 :');
  assert.ok(!requestId.includes('.'), '不得含 .');

  // 核心：信号路径必须是 /tmp 下的**扁平文件**，绝不生成幽灵子目录（否则 writeFile(wx) → ENOENT）。
  const signalPath = getApprovalSignalPath(requestId);
  assert.equal(posix.dirname(signalPath), '/tmp');
  assert.ok(!signalPath.slice('/tmp/'.length).includes('/'), '文件名内不得再有 /');
});

test('XHS 不透明十六进制 noteId 原样保留（不误伤既有安全 id）', () => {
  const xhsNoteId = '66a1b2c3d4e5f60123456789';
  const requestId = buildCommentApprovalRequestId(xhsNoteId, 42);
  assert.equal(requestId, `comment-${xhsNoteId}-42`);
  assert.match(requestId, PANEL_WHITELIST);
});

test('sanitize：路径穿越尝试被中和（../ 无法逃逸 /tmp）', () => {
  const evil = '../../etc/passwd';
  const seg = sanitizeApprovalRequestSegment(evil);
  assert.ok(!seg.includes('/'));
  assert.ok(!seg.includes('..') || PANEL_WHITELIST.test(seg));
  const signalPath = getApprovalSignalPath(buildCommentApprovalRequestId(evil, 7));
  assert.equal(posix.dirname(signalPath), '/tmp');
});

test('连续非法字符折叠为单个 _；时间戳保唯一', () => {
  assert.equal(sanitizeApprovalRequestSegment('a://b??c'), 'a_b_c');
  const a = buildCommentApprovalRequestId('https://x/y', 1000);
  const b = buildCommentApprovalRequestId('https://x/y', 1001);
  assert.notEqual(a, b); // 同 URL 不同 ts 仍唯一
});
