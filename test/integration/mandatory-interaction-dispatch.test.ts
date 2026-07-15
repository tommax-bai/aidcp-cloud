import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { ActionCooldownGate } from '../../src/risk/action-cooldown.js';
import type { MandatoryInteractionContext } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'Tianxing Bai', role: 'người tìm việc', background: 'Tìm việc tại Việt Nam', tone: 'thân thiện' },
  interests: { primary: ['tuyển dụng'], secondary: [], seed_keywords: ['cần tuyển'] },
};
const mandatoryInteraction: MandatoryInteractionContext = {
  ruleId: 'vietnam-recruitment',
  actions: ['like', 'comment'],
  commentGuidance: 'Bình luận bằng tiếng Việt và hỏi về công việc.',
  commentApproval: 'auto_approve',
};
const now = 1_000_000;

function makeDispatcher(canInteract: () => boolean): { dispatcher: RoleDispatcher; commands: EdgeCommand[] } {
  const commands: EdgeCommand[] = [];
  const cooldownGate = new ActionCooldownGate({ startedAtMs: 0, restartQuietMs: 0 });
  cooldownGate.markActed('acc-fb', 'like', now - 1_000);
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => '{"verdict":"skip","reason":"unused"}' },
    sendCommand: (command) => { commands.push(command); },
    canInteract,
    cooldownGate,
    clock: () => now,
  });
  dispatcher.setCurrentAccountId('acc-fb');
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands };
}

describe('mandatory interaction dispatch safety', () => {
  it('mandatory like 绕过普通动作冷却并真实下发', () => {
    const { dispatcher, commands } = makeDispatcher(() => true);
    dispatcher.bus.emit('interaction.completed', {
      noteId: 'fb-job',
      sourcePageType: 'feed',
      actions: ['like'],
      mandatoryInteraction,
      ts: now,
    });

    const likes = commands.filter((command) => command.action === 'like');
    assert.equal(likes.length, 1);
    assert.equal(likes[0]?.params?.noteId, 'fb-job');
    dispatcher.endSession('test');
  });

  it('RiskController 硬闸拒绝时 mandatory like 仍诚实不下发', () => {
    const { dispatcher, commands } = makeDispatcher(() => false);
    dispatcher.bus.emit('interaction.completed', {
      noteId: 'fb-job',
      sourcePageType: 'feed',
      actions: ['like'],
      mandatoryInteraction,
      ts: now,
    });

    assert.equal(commands.some((command) => command.action === 'like'), false);
    dispatcher.endSession('test');
  });
});
