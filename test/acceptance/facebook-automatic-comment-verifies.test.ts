/**
 * AC-FB-FASTRETURN — 自动触发的 Facebook 评论路径绝不携带快返开关。
 *
 * spec `facebook-scheduled-comment`「Facebook manual comment fast return」：when and only when 手动 `--feed`。
 * 快返 = 回车后 500ms 直接导航回首页、跳过就地确认循环、固定回 `verification_ambiguous`。自动路径带上它，
 * 结构上永远不可能报「已评论」：每次都按「提交但未确认」记账 → 打去重烧掉目标帖、覆盖冷却不落、当日配额不计。
 * 2026-07-28 真机实证：评论其实已上墙（FB 活动日志 + 刷新后 comment_id 仍在），系统却一律报未确认。
 *
 * 事实源翻转后（invert-split-fact-source 5.6 re-anchor）：这条红线的现役落点在
 * aidcp-automation —— 规则模式触发闭包在自动化组装根的连接调度层
 * （`src/automation-connection-dispatcher.ts`，选项由同文件的 `ruleBatchContactCommentOptions` 构造），
 * 手动 `--feed` 的透传在 `src/comment-agent/comment-scheduler.ts`。单体 `src/server.ts` 已冻结、
 * 不再部署，读它只会给一张永远绿的死照片。属主仓自身没有这条守卫，故它留在本集成仓。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { siblingRepoRoot } from '../helpers/sibling-repos.js';

const automationSource = async (rel: string): Promise<string> =>
  readFile(join(siblingRepoRoot('aidcp-automation'), 'src', rel), 'utf8');

test('AC-FB-FASTRETURN: 规则模式加群+联系评论不请求快返', async () => {
  const dispatcher = await automationSource('automation-connection-dispatcher.ts');
  assert.ok(
    dispatcher.includes('triggerFacebookRuleJoinContact: async (accountId: string) => {'),
    '断言锚点失效：连接调度层应仍是规则模式加群+评论触发点',
  );
  assert.ok(
    dispatcher.includes('ruleBatchContactCommentOptions({'),
    '断言锚点失效：触发闭包应仍经统一的规则批次选项构造函数下发',
  );
  assert.match(
    dispatcher,
    /joinFirst:\s*true/,
    '断言锚点失效：规则批次选项应仍带「先加群」标记（它是加群+评论触发点的身份特征）',
  );
  assert.ok(
    !/fastReturnToFeed:\s*true/.test(dispatcher),
    '自动规则批次绝不能写死 fastReturnToFeed: true（会让该路径结构上永远无法确认评论）',
  );
});

test('AC-FB-FASTRETURN: 快返仍由手动指令选项透传', async () => {
  const scheduler = await automationSource('comment-agent/comment-scheduler.ts');
  assert.ok(
    /fastReturnToFeed:\s*options\?\.fastReturnToFeed === true/.test(scheduler),
    '手动 --feed 路径必须仍能透传快返开关',
  );
});
