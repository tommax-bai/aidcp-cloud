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
