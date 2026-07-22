/**
 * 启动期 schema 契约门的脱库单测（change cloud-schema-migration-executor 任务 6.1 / 6.6）。零数据库依赖。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadMigrationFiles, maxVersionOf } from '../../src/schema/migration-files.js';
import {
  KNOWN_MAX_SCHEMA_VERSION,
  REQUIRED_SCHEMA_VERSION,
  evaluateSchemaGate,
  formatGateConclusion,
  parseAllowSchemaAhead,
  parseSchemaGateMode,
} from '../../src/schema/schema-contract.js';

/** 与目录一致：构建产物里不一定带 migrations/，所以常量是写死的，由本用例守住它别忘了抬。 */
test('KNOWN_MAX_SCHEMA_VERSION 等于 migrations/ 的最大版本；REQUIRED 不高于它', async () => {
  const files = await loadMigrationFiles();
  assert.equal(
    KNOWN_MAX_SCHEMA_VERSION,
    maxVersionOf(files),
    '新增迁移后 MUST 把 KNOWN_MAX_SCHEMA_VERSION 抬到新的最大版本（见 migrations/README.md §7）',
  );
  const versions = files.map((f) => f.name.replace(/\.sql$/, ''));
  assert.ok(versions.includes(REQUIRED_SCHEMA_VERSION), 'REQUIRED_SCHEMA_VERSION 必须是真实存在的迁移');
});

const KNOWN = ['0001_a', '0002_bot_chats', '0002_risk_control', '0009_c', '0010_d'];

function gate(ledgerVersions: string[], extra: Partial<Parameters<typeof evaluateSchemaGate>[0]> = {}) {
  return evaluateSchemaGate({
    ledgerVersions,
    knownVersions: KNOWN,
    required: '0002_risk_control',
    knownMax: '0010_d',
    ...extra,
  });
}

test('三分支：低于 required / 区间内 / 高于 knownMax', () => {
  const behind = gate(['0001_a', '0002_bot_chats']);
  assert.equal(behind.status, 'behind');
  assert.equal(behind.code, 'schema_behind_code');
  assert.equal(behind.pass, false);
  assert.deepEqual(behind.missing, ['0002_risk_control'], '缺失清单 MUST 逐条列出，不能只说「落后了」');

  const ok = gate(['0001_a', '0002_bot_chats', '0002_risk_control', '0009_c']);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.pass, true);
  assert.equal(ok.ledgerMax, '0009_c');

  const ahead = gate([...KNOWN, '0011_future', '0012_further']);
  assert.equal(ahead.status, 'ahead');
  assert.equal(ahead.code, 'schema_ahead_of_code');
  assert.equal(ahead.pass, false);
  assert.deepEqual(ahead.ahead, ['0011_future', '0012_further']);
});

test('等于 required 即通过（边界不是「高于」）', () => {
  const boundary = gate(['0001_a', '0002_bot_chats', '0002_risk_control']);
  assert.equal(boundary.status, 'ok');
  assert.equal(boundary.pass, true);
});

test('复合序比较：0002_risk_control > 0002_bot_chats，不是字符串比较', () => {
  // 账本最高版本是 0002_bot_chats 时，required=0002_risk_control 仍算落后 —— 纯字符串比较也能得出
  // 同样结论，但下面这一条只有复合序才对：账本 9_x、required 10_x。
  const behind = gate(['0002_bot_chats']);
  assert.equal(behind.status, 'behind');

  const numeric = evaluateSchemaGate({
    ledgerVersions: ['9_x'],
    knownVersions: ['9_x', '10_y'],
    required: '10_y',
    knownMax: '10_y',
  });
  assert.equal(numeric.status, 'behind', '字符串比较会把 9_x 判成「高于」10_y，那是反的');
});

test('账本读不出来 → unreadable，同样拒绝（无法证明 schema 正确）', () => {
  const unreadable = gate([], { ledgerError: '账本表 schema_migrations 不存在' });
  assert.equal(unreadable.status, 'unreadable');
  assert.equal(unreadable.code, 'schema_ledger_unreadable');
  assert.equal(unreadable.pass, false);
});

test('放行通道只接受具体版本 id；布尔 / 空 / 通配一律视为未放行', () => {
  for (const raw of ['true', 'TRUE', '1', 'yes', 'on', '*', 'all', '', '   ', 'latest', undefined]) {
    assert.equal(parseAllowSchemaAhead(raw), undefined, `${String(raw)} MUST NOT 被当成放行`);
  }
  assert.equal(parseAllowSchemaAhead('0011_future'), '0011_future');

  const notWaived = gate([...KNOWN, '0011_future'], { allowAheadRaw: 'true' });
  assert.equal(notWaived.pass, false, '布尔旁路一旦被认可就永久生效，下一次真正危险的超前也会被同一个开关放过');

  const waived = gate([...KNOWN, '0011_future'], { allowAheadRaw: '0011_future' });
  assert.equal(waived.waived, true);
  assert.equal(waived.pass, true);
  assert.equal(waived.waivedUpTo, '0011_future');

  // 放行只覆盖到填写的那一条：再超前一条就必须重新表态。
  const beyond = gate([...KNOWN, '0011_future', '0012_further'], { allowAheadRaw: '0011_future' });
  assert.equal(beyond.pass, false, '放行 MUST NOT 是「一次开启即永久生效」');
});

test('warn 与 enforce 的判定结论逐字一致，模式只决定拒不拒绝启动', () => {
  assert.equal(parseSchemaGateMode('enforce'), 'enforce');
  assert.equal(parseSchemaGateMode('warn'), 'warn');
  assert.equal(parseSchemaGateMode(undefined), 'warn', '默认 warn');
  assert.equal(parseSchemaGateMode('ENFORCE '), 'enforce');
  assert.equal(parseSchemaGateMode('yes'), 'warn', '非 enforce 一律按 warn，MUST NOT 误认成开启');

  // 判定层不接受 mode 参数 —— 结论就无从因模式而变。这条断言守住的是「结论只有一份」这个结构事实。
  const decision = gate([...KNOWN, '0011_future']);
  const conclusion = formatGateConclusion(decision);
  assert.match(conclusion, /超前版本：0011_future/);
  assert.match(conclusion, /回滚场景/);
  assert.equal(formatGateConclusion(gate([...KNOWN, '0011_future'])), conclusion);
});
