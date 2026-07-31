import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelegatedText } from '../../src/delegated-task/parser.js';

const NOW = Date.parse('2026-07-15T10:00:00+08:00');

test('parses batch comment goal with nickname, success count, attempts and priority', () => {
  const parsed = parseDelegatedText('让小萝北今晚前完成 5 条有效评论，最多尝试 8 次，优先执行', { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== 'intent') return;
  assert.equal(parsed.nickname, '小萝北');
  assert.equal(parsed.intent.action, 'comment_batch');
  assert.equal(parsed.intent.targetSuccessCount, 5);
  assert.equal(parsed.intent.maxAttempts, 8);
  assert.equal(parsed.intent.priority, 'high');
  assert.ok(parsed.intent.deadlineAt > NOW);
});

test('legacy write slash command remains syntax-compatible but becomes a single task intent', () => {
  const parsed = parseDelegatedText('/comment 工程师大白 --contact --force --feed', { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== 'intent') return;
  assert.equal(parsed.nickname, '工程师大白');
  assert.equal(parsed.intent.source, 'legacy_command');
  assert.equal(parsed.intent.targetSuccessCount, 1);
  assert.equal(parsed.intent.targetConstraints?.manualSingle, true);
  assert.equal(parsed.intent.targetConstraints?.injectContact, true);
  assert.equal(parsed.intent.targetConstraints?.fastReturnToFeed, true);
});

test('parses candidates, curated comment and task controls', () => {
  const candidates = parseDelegatedText('让小萝北生成 3 个候选稿但暂不发布', { now: NOW });
  assert.equal(candidates.ok && candidates.kind === 'intent' ? candidates.intent.action : '', 'generate_candidates');
  const curated = parseDelegatedText('让小萝北对精选内容 42 发起评论', { now: NOW });
  assert.equal(curated.ok && curated.kind === 'intent' ? curated.intent.targetConstraints?.curatedId : '', '42');
  const control = parseDelegatedText('暂停任务 019f6475-dbc7-4913-be36-2cd0b174762e', { now: NOW });
  assert.equal(control.ok && control.kind === 'control' ? control.action : '', 'pause');
});

test('fails closed when curated target or nickname is missing', () => {
  const curated = parseDelegatedText('对精选内容发起评论', { now: NOW });
  assert.equal(curated.ok, false);
  const vague = parseDelegatedText('完成 5 条评论', { now: NOW });
  assert.equal(vague.ok, false);
});

/**
 * `/task` 前缀（2026-07-31 真机验收撞到的真 bug）。
 *
 * 飞书路由层把 `/task …` 明确当作委托触发词放行，而解析器此前**只有控制类那条正则**容忍这个前缀，
 * 业务类六条一条都没有。于是带前缀的业务指令会把 `/task 让 小明` 整个当成昵称去解析账号，
 * 报出来的是「需要补充信息」——**指向的方向完全不对**，运营会去反复改措辞。
 * 实测：同一句话去掉前缀立刻成功建单，带上就连试六次全败。
 *
 * **两种写法 MUST 解析成同一个意图。** 只测「带前缀能过」是不够的——那样把前缀连同昵称一起吃掉
 * 也算过；要钉的是**两者结果相同**。
 */
test('/task 前缀不属于业务文本：带与不带 MUST 解析成同一个意图', () => {
  const cases = [
    '让 小明 发布一篇稿件',
    '让 小明 完成 3 条有效评论',
    '让 小明 参考今日灵感发布一篇稿件',
    '让 小明 生成 2 篇候选稿但暂不发布',
  ];
  for (const sentence of cases) {
    const bare = parseDelegatedText(sentence, { source: 'feishu' });
    const prefixed = parseDelegatedText(`/task ${sentence}`, { source: 'feishu' });
    assert.equal(bare.ok, true, `裸句 MUST 解析得出：${sentence}`);
    assert.equal(prefixed.ok, true, `带 /task MUST 同样解析得出：${sentence}`);
    // ⚠️ **这里写错过一次，值得留着当判例**：第一版比的是 `kind === 'task'`，而真实取值是
    // `'intent'`。两边于是恒取到 null，`deepEqual(null, null)` 恒过——**用例是空转的**，
    // 拿掉被测的那行前缀剥离它照样绿。是 typecheck 报「这个比较不可能成立」才发现的。
    // 教训与本轮 §6.5 那条同形：**用例绿不等于它在守东西**，得拿变异问一句「谁抓住的」。
    assert.ok(bare.ok && bare.kind === 'intent', `裸句 MUST 得到 intent：${sentence}`);
    assert.ok(prefixed.ok && prefixed.kind === 'intent', `带 /task MUST 得到 intent：${sentence}`);
    assert.equal(
      prefixed.nickname,
      bare.nickname,
      `昵称 MUST 不把 /task 前缀吃进去：${sentence}`,
    );
    assert.deepEqual(
      prefixed.intent,
      bare.intent,
      `两种写法 MUST 得到同一个意图：${sentence}`,
    );
  }
});
