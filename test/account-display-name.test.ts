import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountDisplayNameCandidates,
  readableAccountDisplayName,
  resolveAccountDisplayName,
  resolveNotificationAccountName,
} from '../src/account-display-name.js';

test('resolveAccountDisplayName uses the single operator/platform/label/id priority', () => {
  const full = { accountId: 'acc-1', operatorAlias: '运营一号', nickname: '平台真名', label: '标签' };
  assert.deepEqual(resolveAccountDisplayName(full), { name: '运营一号', source: 'operator_alias' });
  assert.deepEqual(resolveAccountDisplayName({ ...full, operatorAlias: null }), {
    name: '平台真名', source: 'platform_nickname',
  });
  assert.deepEqual(resolveAccountDisplayName({ ...full, operatorAlias: ' ', nickname: null }), {
    name: '标签', source: 'label',
  });
  assert.deepEqual(resolveAccountDisplayName({ accountId: 'acc-1', label: 'acc-1' }), {
    name: 'acc-1', source: 'account_id',
  });
});

test('readableAccountDisplayName hides a machine-only account id', () => {
  assert.equal(readableAccountDisplayName({ name: 'acc-1', source: 'account_id' }), '（未获取昵称）');
  assert.equal(readableAccountDisplayName({ name: '运营一号', source: 'operator_alias' }), '运营一号');
});

test('accountDisplayNameCandidates accepts aliases and legacy names but never account ids', () => {
  assert.deepEqual(accountDisplayNameCandidates({
    accountId: 'acc-1', operatorAlias: '运营一号', nickname: '平台真名', label: '运营一号',
  }), ['运营一号', '平台真名']);
  assert.deepEqual(accountDisplayNameCandidates({ accountId: 'acc-1', label: 'acc-1' }), []);
});

test('resolveNotificationAccountName prefers the live directory over an event snapshot', () => {
  const lookup = (accountId: string) => accountId === 'acc-1' ? 'Tianxing Bai1' : undefined;
  assert.equal(resolveNotificationAccountName('acc-1', 'Tianxing Bai', lookup), 'Tianxing Bai1');
  assert.equal(resolveNotificationAccountName('missing', '  旧事件名称  ', lookup), '旧事件名称');
  assert.equal(resolveNotificationAccountName(null, '  仅事件名称  ', lookup), '仅事件名称');
  assert.equal(resolveNotificationAccountName('missing', ' ', lookup), undefined);
});
