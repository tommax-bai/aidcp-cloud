import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  scheduledContactCommentLabel,
  scheduledContactCommentOptions,
} from '../../src/orchestrator/content-scheduler.js';

// ── change decouple-scheduled-contact-comment-from-group-join ──
//
// 排期联系评论**不再先加群**。拆分的机制理由：评论路径取容器有两种方式——外部传入的固定容器，
// 或调用已加入群账本的选群口；**选群口是预热期与单群冷却唯一被检查的地方**。带「先加群」标记时，
// 刚加入的那个群会被设成固定容器，选群口根本不会被调用，两道闸永远不参与判定。
//
// 拆的只有排期这一个入口。手动命令 / 委托任务 / 固定规则模式三条路径原样保留。

test('排期联系评论：Facebook 不再携带「先加群」标记', () => {
  const opts = scheduledContactCommentOptions('facebook', 'review');
  assert.deepEqual(opts, {
    injectContact: true,
    priority: 'automatic',
    approvalMode: 'review',
  });
  // 显式断言键不存在，而不是只靠 deepEqual——后者在实现把值写成 undefined 时会漏过去。
  assert.equal('joinFirst' in opts, false, '排期路径 MUST NOT 带 joinFirst');
});

test('排期联系评论：非 Facebook 行为不变，同样不带「先加群」', () => {
  const opts = scheduledContactCommentOptions('xiaohongshu', 'auto_approve');
  assert.deepEqual(opts, {
    injectContact: true,
    priority: 'automatic',
    approvalMode: 'auto_approve',
  });
  assert.equal('joinFirst' in opts, false);
});

test('排期联系评论：动作名全平台一致为「联系评论」（Facebook 旧名已废）', () => {
  assert.equal(scheduledContactCommentLabel('facebook'), '联系评论');
  assert.equal(scheduledContactCommentLabel('xiaohongshu'), '联系评论');
});

/**
 * 其余三个入口 MUST 仍带「先加群」——本用例专挡「一刀切把 joinFirst 全删掉」的误改。
 *
 * 用源码文本断言而不是调函数：这三处分别在飞书手动出口、委托任务执行器与规则模式批次里，
 * 各自深埋在需要大量注入才能跑起来的路径上；为一条「参数有没有传」的回归去搭那些桩，
 * 成本远高于收益，而文本断言恰好能抓住「顺手全删」这个真实的误改形态。
 */
test('拆分不外溢：手动 / 委托 / 规则模式三个入口仍带「先加群」', async () => {
  const url = (p: string) => new URL(p, import.meta.url);
  const server = await readFile(url('../../src/server.ts'), 'utf8');
  const executors = await readFile(url('../../src/delegated-task/executors.ts'), 'utf8');

  // 飞书手动命令：按 --join 参数条件传入（不是恒 true）。
  assert.match(server, /joinFirst:\s*options\?\.joinGroup/, '手动命令入口的 joinFirst 传参不得被删');
  // 固定规则模式轮次：恒 true（用户 2026-07-29 决定不拆规则模式）。
  assert.match(server, /joinFirst:\s*true/, '规则模式轮次的 joinFirst 不得被删');
  // 委托任务：恒 true。
  assert.match(executors, /joinFirst:\s*true/, '委托任务入口的 joinFirst 不得被删');
});

/**
 * 排期触发口 MUST 仍只经由本模块的选项构造函数下发，不得自己另拼一份带 joinFirst 的参数——
 * 否则拆分会以「函数改干净了、调用点又塞回来」的形态静默失效。
 */
test('排期触发口只用统一的选项构造函数下发参数', async () => {
  const server = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /scheduledContactCommentOptions\(platform, approvalMode\)/);
});
