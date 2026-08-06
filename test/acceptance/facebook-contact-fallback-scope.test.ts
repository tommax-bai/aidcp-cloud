/**
 * AC-FBFALLBACK-* — 缺联系方式降级的**范围锁**（change facebook-rule-comment-plain-fallback）。
 *
 * 这次改动具名放弃了两份已上线规格的 fail-closed 保证（group-chat-injection、
 * facebook-group-comment-coverage），但**只对 Facebook 规则模式的加群联系评论一条链路**。
 * 共用那道闸的另外五个入口必须原样保持。
 *
 * 范围一旦蔓延就很难再收回来：闸上多了个开关之后，后来的调用方顺手打开是最自然不过的事，
 * 而且打开时不会有任何东西报错。所以这里用机械手段钉住「谁可以传」。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  joinCommentReceipt,
  type FacebookCommentRunResult,
} from '@automation/comment-agent/comment-scheduler.js';

import {
  derivedCompositionRoots,
  ownedSourcePath,
  type OwnerLayer,
} from '../helpers/sibling-repos.js';

/**
 * 事实源翻转后（invert-split-fact-source 5.6 裁定）：范围锁的扫描面从单体五文件换成
 * 「四个属主文件 + 三个派生仓组装根并集」。单体 `src/server.ts` 里的规则模式接线现役落点
 * 是 automation 仓的连接调度层（automation-connection-dispatcher.ts，属组装根并集）；
 * 只扫任何单一文件都会把「全机只有一处传」弱化成「某仓只有一处传」。
 */
const OWNED_FILES: ReadonlyArray<{ owner: OwnerLayer; rel: string }> = [
  { owner: 'api', rel: 'orchestrator/content-scheduler.ts' },
  { owner: 'api', rel: 'feishu/commands.ts' },
  { owner: 'automation', rel: 'delegated-task/executors.ts' },
  { owner: 'automation', rel: 'comment-agent/comment-scheduler.ts' },
];

const readOwned = (owner: OwnerLayer, rel: string) => readFile(ownedSourcePath(owner, rel), 'utf8');
/** 剥行注释：本仓注释密度高，且这些文件的注释里逐字写着「谁不许传」，不剥会自伤。 */
const executable = (sql: string) => sql.replace(/\/\/.*$/gm, '');

test('AC-FBFALLBACK-01 全机只有 Facebook 规则模式一处传 contactFallback', async () => {
  const sources: Array<{ file: string; body: string }> = [];
  for (const { owner, rel } of OWNED_FILES) {
    sources.push({ file: `${owner}:src/${rel}`, body: executable(await readOwned(owner, rel)) });
  }
  for (const root of derivedCompositionRoots()) {
    sources.push({ file: root.label, body: executable(await readFile(root.path, 'utf8')) });
  }
  const hits: Array<{ file: string; count: number }> = [];
  for (const { file, body } of sources) {
    // 调用侧传参形态：`contactFallback:`。声明侧（选项类型 / 读取处）不算。
    const count = (body.match(/contactFallback:\s*\{/g) ?? []).length;
    if (count > 0) hits.push({ file, count });
  }
  assert.deepEqual(
    hits,
    [{ file: 'aidcp-automation/src/automation-connection-dispatcher.ts', count: 1 }],
    '降级意图 MUST 只由规则模式一处传入（现役落点=automation 连接调度层）；' +
      '新增传参点即为范围蔓延，须先改规格与本用例',
  );
});

test('AC-FBFALLBACK-02 共用闸的默认值是 fail-closed', async () => {
  const body = executable(await readOwned('automation', 'comment-agent/comment-scheduler.ts'));
  // 降级只能由显式声明进入；条件里必须出现对声明本身的判定，而不是「拿不到就降级」。
  assert.match(
    body,
    /options\.contactFallback\?\.kind === 'plain'/,
    '降级分支 MUST 由调用方显式声明驱动',
  );
  // 默认分支仍返回原来的 fail-closed 回执。
  assert.match(body, /绝不发无联系方式评论/);
});

test('AC-FBFALLBACK-03 合并结果卡按实际注入值渲染，降级时明说不带联系方式', () => {
  const join = { outcome: 'joined', groupUrl: 'https://www.facebook.com/groups/1' };
  const commented: FacebookCommentRunResult = {
    outcome: 'commented',
    container: '某某群',
    contactIncluded: false,
    contactFallbackApplied: true,
  };
  const card = joinCommentReceipt(join, commented, commented.contactIncluded === true);
  assert.equal(card.ok, true);
  assert.match(card.message, /不带.*联系方式/, '降级 MUST 在结果卡上明说');
  assert.doesNotMatch(
    card.message,
    /发出一条带联系方式的评论/,
    'MUST NOT 对一条不带码的评论宣称带了联系方式——人审卡上运营刚看过不带码的正文，两张卡会自相矛盾',
  );

  const withContact: FacebookCommentRunResult = {
    outcome: 'commented',
    container: '某某群',
    contactIncluded: true,
  };
  const contactCard = joinCommentReceipt(join, withContact, true);
  assert.match(contactCard.message, /带联系方式的评论/, '真带码时的话术零回归');
});

test('AC-FBFALLBACK-04 降级产出在规则轮次上是可辨识终态，不冒充联系评论已完成', async () => {
  const pattern = /contactFallbackApplied === true[\s\S]{0,200}confirmed_without_contact/;
  const hits: string[] = [];
  for (const root of derivedCompositionRoots()) {
    if (pattern.test(executable(await readFile(root.path, 'utf8')))) hits.push(root.label);
  }
  assert.deepEqual(
    hits,
    ['aidcp-automation/src/automation-connection-dispatcher.ts'],
    '降级发出的评论 MUST 映射为 confirmed_without_contact（且只在规则轮次那一处），MUST NOT 记成 confirmed',
  );
});
