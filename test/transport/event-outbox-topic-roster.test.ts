import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_MIRROR_BUMP_TOPIC } from '@kernel/kernel/config-mirror-bump-types.js';
import { INTERACTION_AUDIT_OUTBOX_TOPIC } from '@kernel/kernel/interaction-audit-outbox.js';
import { SYNC_READ_CHANGED_TOPIC } from '@kernel/kernel/sync-read-snapshot.js';
import { PANEL_EVENT_OUTBOX_TOPIC } from '@automation/transport/eventbus-outbox-bridge.js';
import {
  assertOutboxRetentionCoverage,
  EVENT_OUTBOX_RETENTION_ROSTER,
  EVENT_OUTBOX_TOPIC_NAMES,
  EVENT_OUTBOX_TOPICS,
  outboxTopicsRequiringRetention,
  reviewOutboxRetentionCoverage,
} from '@automation/transport/event-outbox-topic-roster.js';
import { RISK_COMMAND_TOPIC } from '@automation/transport/risk-command-outbox.js';

// 登记表里的主题名是**手抄**的（避免在这张表上拉出跨属主 import 图）。
// 手抄名单会与事实源漂移，本仓有前科 —— 所以这条引用断言才是它成立的前提：
// 光有登记表不算数，必须逐条 === 真正的导出常量。
test('roster topic names are asserted against the real exported constants, not hand-copied on trust', () => {
  assert.equal(EVENT_OUTBOX_TOPIC_NAMES.panelEvent, PANEL_EVENT_OUTBOX_TOPIC);
  assert.equal(EVENT_OUTBOX_TOPIC_NAMES.riskCommand, RISK_COMMAND_TOPIC);
  assert.equal(
    EVENT_OUTBOX_TOPIC_NAMES.interactionAudit,
    INTERACTION_AUDIT_OUTBOX_TOPIC,
  );
  assert.equal(
    EVENT_OUTBOX_TOPIC_NAMES.configMirrorBump,
    CONFIG_MIRROR_BUMP_TOPIC,
  );
  assert.equal(EVENT_OUTBOX_TOPIC_NAMES.syncReadChanged, SYNC_READ_CHANGED_TOPIC);

  // 反向：登记表覆盖的就是全部已知主题，没有第六条躲在别处。
  assert.deepEqual([...EVENT_OUTBOX_TOPICS].sort(), [
    'config_mirror.bump',
    'interaction.audit_event',
    'panel.event',
    'risk.command',
    'sync_read.changed',
  ]);
  assert.deepEqual(
    Object.keys(EVENT_OUTBOX_RETENTION_ROSTER).sort(),
    [...EVENT_OUTBOX_TOPICS].sort(),
  );
});

test('every topic carries a retention disposition, and "not pruned" must state a reason', () => {
  for (const topic of EVENT_OUTBOX_TOPICS) {
    const disposition = EVENT_OUTBOX_RETENTION_ROSTER[topic];
    if (disposition.prune) {
      assert.ok(
        disposition.note.trim().length > 0,
        `${topic} 声明要剪，但没写怎么剪`,
      );
    } else {
      // 「不需要剪」是正式结论，MUST 带理由 —— 没理由的「不剪」与「漏了」同形。
      assert.ok(
        disposition.reason.trim().length > 0,
        `${topic} 声明不剪却没给理由`,
      );
    }
  }
});

test('coverage review names an unpruned topic instead of collapsing it into a boolean', () => {
  const all = outboxTopicsRequiringRetention();
  assert.ok(all.includes('sync_read.changed'));
  assert.ok(all.includes('config_mirror.bump'));

  // 全覆盖 ⇒ 三个方向都空、不抛。
  assert.deepEqual(reviewOutboxRetentionCoverage(all), {
    uncovered: [],
    unregistered: [],
    prunedDespiteDisposition: [],
  });
  assert.doesNotThrow(() => assertOutboxRetentionCoverage(all));

  // 这正是本次生产上的形态：剪裁器接了、名单里独独少这一条。
  const missingOne = all.filter((topic) => topic !== 'sync_read.changed');
  assert.deepEqual(reviewOutboxRetentionCoverage(missingOne).uncovered, [
    'sync_read.changed',
  ]);
  assert.throws(
    () => assertOutboxRetentionCoverage(missingOne),
    /sync_read\.changed/,
    '漏掉的主题 MUST 在错误文案里被点名',
  );

  // 名字写错：登记表里那条依然没人剪，且拼错的那个也要被点出来。
  const typo = [...missingOne, 'sync_read.change'];
  const report = reviewOutboxRetentionCoverage(typo);
  assert.deepEqual(report.uncovered, ['sync_read.changed']);
  assert.deepEqual(report.unregistered, ['sync_read.change']);
  assert.throws(() => assertOutboxRetentionCoverage(typo), /sync_read\.change/);
});
