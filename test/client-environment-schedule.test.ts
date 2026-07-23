import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectClientEnvironmentSchedule,
  type ClientEnvironmentScheduleView,
} from '../src/client-auth/client-environment-schedule.js';
import type { EffectiveContentSchedule } from '../src/config/content-schedule-store.js';

function mask(cells: Array<[number, number]>): string {
  const value = Array.from({ length: 168 }, () => '0');
  for (const [day, hour] of cells) value[day * 24 + hour] = '1';
  return value.join('');
}

function hours(day: number, start: number, end: number): Array<[number, number]> {
  return Array.from({ length: end - start }, (_, index) => [day, start + index]);
}

function schedule(overrides: Partial<EffectiveContentSchedule> = {}): EffectiveContentSchedule {
  return {
    autoEnabled: true,
    postEnabled: true,
    postMode: 'review',
    postDailyCap: 1,
    commentEnabled: false,
    commentMode: 'off',
    commentDailyCap: 0,
    contactCommentEnabled: false,
    contactCommentMode: 'off',
    contactCommentDailyCap: 0,
    effectiveActiveWeekMask: null,
    effectiveMask: null,
    ...overrides,
  };
}

function assertNoInternalFields(view: ClientEnvironmentScheduleView): void {
  const json = JSON.stringify(view);
  for (const forbidden of ['accountId', 'activeWeekMask', 'effectiveMask', 'override', 'updatedBy']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
}

test('projects missing activity as full week and missing content as empty', () => {
  const view = projectClientEnvironmentSchedule(schedule(), {
    now: new Date(2026, 6, 20, 10, 30).getTime(), // Monday, server-local
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(view.days[0].activityRanges, [{ startHour: 0, endHour: 24 }]);
  assert.deepEqual(view.days[6].activityRanges, [{ startHour: 0, endHour: 24 }]);
  assert.deepEqual(view.days[0].contentRanges, []);
  assert.equal(view.windows.currentActivity?.day, 'monday');
  assert.equal(view.windows.currentContent, null);
  assert.equal(view.windows.nextActivity?.day, 'tuesday');
  assertNoInternalFields(view);
});

test('clamps content ranges to activity and condenses adjacent hours', () => {
  const activity = mask([...hours(0, 9, 12), ...hours(0, 14, 17)]);
  const content = mask([...hours(0, 8, 11), ...hours(0, 15, 18)]);
  const view = projectClientEnvironmentSchedule(schedule({
    effectiveActiveWeekMask: activity,
    effectiveMask: content,
  }), {
    now: new Date(2026, 6, 20, 13, 0).getTime(),
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(view.days[0].activityRanges, [
    { startHour: 9, endHour: 12 },
    { startHour: 14, endHour: 17 },
  ]);
  assert.deepEqual(view.days[0].contentRanges, [
    { startHour: 9, endHour: 11 },
    { startHour: 15, endHour: 17 },
  ]);
  assert.equal(view.windows.currentActivity, null);
  assert.deepEqual(
    {
      day: view.windows.nextActivity?.day,
      startHour: view.windows.nextActivity?.startHour,
      endHour: view.windows.nextActivity?.endHour,
    },
    { day: 'monday', startHour: 14, endHour: 17 },
  );
});

test('finds current and next windows across the end of the week', () => {
  const activity = mask([...hours(6, 22, 24), ...hours(0, 8, 10)]);
  const view = projectClientEnvironmentSchedule(schedule({
    effectiveActiveWeekMask: activity,
  }), {
    now: new Date(2026, 6, 26, 22, 15).getTime(), // Sunday
    timezone: 'Asia/Shanghai',
  });
  assert.equal(view.windows.currentActivity?.day, 'sunday');
  assert.equal(view.windows.currentActivity?.endHour, 24);
  assert.equal(view.windows.currentActivity?.endsAt, new Date(2026, 6, 27, 0, 0).getTime());
  assert.equal(view.windows.nextActivity?.day, 'monday');
  assert.equal(view.windows.nextActivity?.dayOffset, 1);
  assert.equal(view.windows.nextActivity?.startHour, 8);
});

test('projects only actually enabled actions with customer copy', () => {
  const view = projectClientEnvironmentSchedule(schedule({
    postMode: 'review',
    postDailyCap: 2,
    commentEnabled: true,
    commentMode: 'auto_approve',
    commentDailyCap: 3,
    contactCommentEnabled: true,
    contactCommentMode: 'review',
    contactCommentDailyCap: 1,
  }), { timezone: 'Asia/Shanghai' });
  assert.deepEqual(view.actions, [
    {
      key: 'post',
      label: '创作与发布',
      dailyCap: 2,
      approval: 'review',
      resultCopy: '草稿完成后等你确认',
    },
    {
      key: 'comment',
      label: '评论互动',
      dailyCap: 3,
      approval: 'automatic',
      resultCopy: '检查通过后按安排互动',
    },
    {
      key: 'contact_comment',
      label: '联系评论',
      dailyCap: 1,
      approval: 'review',
      resultCopy: '联系内容完成后等你确认',
    },
  ]);
  assertNoInternalFields(view);
});

test('auto disabled keeps effective windows visible but reports no automatic actions', () => {
  const content = mask(hours(0, 9, 10));
  const view = projectClientEnvironmentSchedule(schedule({
    autoEnabled: false,
    effectiveMask: content,
  }), {
    now: new Date(2026, 6, 20, 8, 0).getTime(),
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(view.days[0].contentRanges, [{ startHour: 9, endHour: 10 }]);
  assert.deepEqual(view.actions, []);
  assert.equal(view.autoEnabled, false);
});

test('disabled action is omitted even if a stale mode and cap remain', () => {
  const view = projectClientEnvironmentSchedule(schedule({
    postEnabled: false,
    postMode: 'auto_approve',
    postDailyCap: 3,
  }));
  assert.deepEqual(view.actions, []);
});
