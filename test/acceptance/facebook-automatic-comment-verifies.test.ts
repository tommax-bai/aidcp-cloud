/**
 * AC-FB-FASTRETURN — 自动触发的 Facebook 评论路径绝不携带快返开关。
 *
 * spec `facebook-scheduled-comment`「Facebook manual comment fast return」：when and only when 手动 `--feed`。
 * 快返 = 回车后 500ms 直接导航回首页、跳过就地确认循环、固定回 `verification_ambiguous`。自动路径带上它，
 * 结构上永远不可能报「已评论」：每次都按「提交但未确认」记账 → 打去重烧掉目标帖、覆盖冷却不落、当日配额不计。
 * 2026-07-28 真机实证：评论其实已上墙（FB 活动日志 + 刷新后 comment_id 仍在），系统却一律报未确认。
 *
 * 触发点写在组装根内联闭包里（`buildDispatcher` 的 `triggerFacebookRuleJoinContact`），无法脱离整机装配单测，
 * 故按本仓既有惯例做源码级断言（同 composition-root-*.test.ts）。
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const serverSource = async (): Promise<string> =>
  readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');

const sliceBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
};

test('AC-FB-FASTRETURN: 规则模式加群+联系评论不请求快返', async () => {
  const source = await serverSource();
  const body = sliceBetween(
    source,
    'triggerFacebookRuleJoinContact: async (accountId: string) => {',
    'commentAutoApproveNotify',
  );
  assert.ok(
    body.includes('joinFirst: true'),
    '断言锚点失效：该闭包应仍是加群+评论触发点',
  );
  assert.ok(
    !/fastReturnToFeed:\s*true/.test(body),
    '自动规则批次绝不能写死 fastReturnToFeed: true（会让该路径结构上永远无法确认评论）',
  );
});

test('AC-FB-FASTRETURN: 快返仍由手动指令选项透传', async () => {
  const source = await serverSource();
  assert.ok(
    /fastReturnToFeed:\s*options\?\.fastReturnToFeed === true/.test(source),
    '手动 --feed 路径必须仍能透传快返开关',
  );
});
