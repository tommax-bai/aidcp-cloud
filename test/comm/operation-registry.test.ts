import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATION_OPERATION_REGISTRY, automationOperationDescriptorFor } from '../../src/comm/operation-registry.js';
import type { MessageType } from '../../src/comm/protocol.js';

test('Cloud automation channel classifies control, API-only automation, browser lifecycle, and page automation', () => {
  assert.deepEqual(automationOperationDescriptorFor('ui.snapshot'), {
    category: 'automation_control', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
  });
  assert.equal(automationOperationDescriptorFor('interaction.reply.send')?.category, 'platform_api_automation');
  assert.equal(automationOperationDescriptorFor('interaction.reply.send')?.browser, 'forbidden');
  assert.equal(automationOperationDescriptorFor('interaction.auth.reopen')?.category, 'browser_lifecycle');
  assert.equal(automationOperationDescriptorFor('page.scroll')?.browser, 'required');
});

test('every registered Cloud push uses automation WebSocket and unknown active operations fail closed', () => {
  for (const descriptor of Object.values(AUTOMATION_OPERATION_REGISTRY)) {
    assert.equal(descriptor.transport, 'automation_ws');
  }
  assert.equal(automationOperationDescriptorFor('future.unclassified' as MessageType), null);
});

test('identity read commands are dispatchable — the edge identity-rescue allowlist needs them', () => {
  // 边缘 src/client/identity-command-gate.ts 把这两条放进身份救援放行清单：运行期身份落到
  // 「不知道浏览器里登着谁」的终局时，只有它们能问出当前登录身份、解开该终局。云端漏登记 ⇒
  // 出口闸判 operation_unclassified 静默拒发（投递数 0）⇒ 该自救通道结构上不成立。
  //
  // 期望值**按引用取自本表里已知正确的同类命令**，不另抄一份字面量：抄一份就是第二实现，
  // 它只能证明「我抄的和我抄的一样」，描述符字段真改了它照样绿。
  const peer = automationOperationDescriptorFor('profile.open');
  assert.notEqual(peer, null, 'profile.open 是本断言的参照锚点，它自己不能是 null');
  for (const type of ['identity.read_current', 'identity.read_self_profile'] as MessageType[]) {
    assert.deepEqual(
      automationOperationDescriptorFor(type),
      peer,
      `${type} 必须可从云端下发，且分类与同类页面自动化命令一致`,
    );
  }
});

test('Cloud/admin cannot push AIDCP-owned data commands through the automation channel', () => {
  const forbiddenDataCommands = [
    'persona.generate',
    'persona.persist',
    'publish.approval_action',
    'publish.draft_image_remove',
  ] as MessageType[];
  for (const type of forbiddenDataCommands) {
    assert.equal(automationOperationDescriptorFor(type), null, `${type} must be pulled/submitted over customer-auth HTTP`);
  }
  const categories = new Set(Object.values(AUTOMATION_OPERATION_REGISTRY).map((entry) => entry.category));
  assert.equal(categories.has('cloud_data' as never), false);
});
