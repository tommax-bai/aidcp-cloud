import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanelUsers, verifyCredentials, parseBearer } from '../src/panel/auth.js';

test('parsePanelUsers 解析多用户', () => {
  const users = parsePanelUsers('alice:pw1,bob:pw2');
  assert.equal(users.length, 2);
  assert.deepEqual(users[0], { username: 'alice', password: 'pw1' });
  assert.deepEqual(users[1], { username: 'bob', password: 'pw2' });
});

test('parsePanelUsers 密码内含冒号（按首个冒号切分）', () => {
  const users = parsePanelUsers('alice:pw:with:colons');
  assert.equal(users.length, 1);
  assert.equal(users[0].password, 'pw:with:colons');
});

test('parsePanelUsers 跳过空项/无冒号/空用户名', () => {
  assert.deepEqual(parsePanelUsers(undefined), []);
  assert.deepEqual(parsePanelUsers(''), []);
  assert.deepEqual(parsePanelUsers('nopassword'), []);
  assert.deepEqual(parsePanelUsers(':pw'), []);
  assert.equal(parsePanelUsers('a:1,,b:2').length, 2);
});

test('verifyCredentials 正确凭据通过', () => {
  const users = parsePanelUsers('alice:pw1,bob:pw2');
  assert.equal(verifyCredentials(users, 'alice', 'pw1'), true);
  assert.equal(verifyCredentials(users, 'bob', 'pw2'), true);
});

test('verifyCredentials 错误密码/未知用户拒绝', () => {
  const users = parsePanelUsers('alice:pw1');
  assert.equal(verifyCredentials(users, 'alice', 'wrong'), false);
  assert.equal(verifyCredentials(users, 'ghost', 'pw1'), false);
  assert.equal(verifyCredentials([], 'alice', 'pw1'), false);
});

test('parseBearer 提取 token', () => {
  assert.equal(parseBearer('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(parseBearer('bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(parseBearer(undefined), undefined);
  assert.equal(parseBearer('Basic xxx'), undefined);
});
