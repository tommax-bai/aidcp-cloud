import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] },
};

test('ADVERSARIAL: unbound account reacts to page.cards even though session never started', async () => {
  const commands: EdgeCommand[] = [];
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => JSON.stringify({ verdict: 'valuable', index: 0, reason: 'r', confidence: 0.9 }) },
    sendCommand: (c) => commands.push(c),
    isPersonaBound: () => false,
    onSessionRejected: () => {},
  });
  d.setup();
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.active, false, 'session should NOT be active (gate worked)');

  d.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'Some note', author: 'a', likeCount: 5, collectCount: 1, noteId: 'n1' }],
    ts: 2,
  });
  await new Promise((r) => setTimeout(r, 80));

  console.log('COMMANDS_SENT=', JSON.stringify(commands));
  const openNotes = commands.filter((c) => c.action === 'open_note');
  assert.equal(openNotes.length, 0, `LEAK: unbound account emitted ${openNotes.length} open_note despite gate`);
  d.endSession();
});
