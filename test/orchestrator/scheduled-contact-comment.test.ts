import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  scheduledContactCommentLabel,
  scheduledContactCommentOptions,
} from '@api/orchestrator/content-scheduler.js';

import { siblingRepoRoot } from '../helpers/sibling-repos.js';

const automationSrc = (rel: string) =>
  readFile(join(siblingRepoRoot('aidcp-automation'), 'src', rel), 'utf8');

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
 * 其余入口 MUST 仍带「先加群」——本用例专挡「一刀切把 joinFirst 全删掉」的误改。
 *
 * 用源码文本断言而不是调函数：这些入口深埋在需要大量注入才能跑起来的路径上；为一条
 * 「参数有没有传」的回归去搭那些桩，成本远高于收益，而文本断言恰好能抓住「顺手全删」
 * 这个真实的误改形态。
 *
 * 事实源翻转后（invert-split-fact-source 5.6 re-anchor）：现役入口在 aidcp-automation ——
 * 规则模式批次在连接调度层（`automation-connection-dispatcher.ts`，恒 true）；手动 `--join`
 * 与委托任务在拆分后合流为同一个委托执行器（`delegated-task/executors.ts` 的
 * `facebook_group_comment` 分支，恒 true；api 侧的手动 /comment 只产出委托任务、不再自己拼参数）。
 * 单体 `src/server.ts` 已冻结、不再部署，不再读它。
 */
test('拆分不外溢：规则模式 / 委托（含手动 --join）入口仍带「先加群」', async () => {
  const dispatcher = await automationSrc('automation-connection-dispatcher.ts');
  const executors = await automationSrc('delegated-task/executors.ts');

  // 固定规则模式轮次：恒 true（用户 2026-07-29 决定不拆规则模式）。
  assert.match(dispatcher, /joinFirst:\s*true/, '规则模式轮次的 joinFirst 不得被删');
  // 委托任务（手动 --join 合流于此）：facebook_group_comment 分支恒 true。
  assert.match(executors, /joinFirst:\s*true/, '委托任务入口的 joinFirst 不得被删');
  assert.ok(
    executors.includes("task.action === 'facebook_group_comment'"),
    '断言锚点失效：加群评论的委托分支不见了——先确认手动 --join 现在从哪里下发 joinFirst',
  );
});

/**
 * 排期触发口 MUST 仍只经由本模块的选项构造函数下发，不得自己另拼一份带 joinFirst 的参数——
 * 否则拆分会以「函数改干净了、调用点又塞回来」的形态静默失效。
 * 现役排期触发口在 aidcp-automation 的 `automation-content-scheduling.ts`。
 */
test('排期触发口只用统一的选项构造函数下发参数', async () => {
  const scheduling = await automationSrc('automation-content-scheduling.ts');
  assert.match(scheduling, /scheduledContactCommentOptions\(/);
  assert.doesNotMatch(scheduling, /joinFirst/, '排期触发文件里不得再出现 joinFirst 的任何拼写');
});
