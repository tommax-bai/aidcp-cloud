import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../src/blackboard/index.js';
import { EventBus } from '../src/event-bus/index.js';
import type { AgentDecision, AgentRole } from '../src/event-bus/types.js';

describe('Blackboard', () => {
  it('setInput + getState：写入输入区后能正确读取', () => {
    const bb = new Blackboard();
    const note = { noteId: 'n1', title: 'T', summary: 'S', likeCount: 10, collectCount: 5 };
    bb.setInput({
      currentNote: note,
      pageType: 'note',
      loginState: 'logged_in',
      availableActions: ['browse_next', 'like'],
    });
    const state = bb.getState();
    assert.deepEqual(state.currentNote, note);
    assert.equal(state.pageType, 'note');
    assert.equal(state.loginState, 'logged_in');
    assert.deepEqual(state.availableActions, ['browse_next', 'like']);
  });

  it('writeDecision：写入决策后 decisions Map 正确', () => {
    const bb = new Blackboard();
    bb.setExpectedAgents(['feed_scanner']);
    const decision: AgentDecision = {
      agent: 'feed_scanner',
      action: 'open_note',
      reason: '好内容',
      confidence: 0.9,
      ts: Date.now(),
    };
    bb.writeDecision(decision);
    const state = bb.getState();
    assert.equal(state.decisions.size, 1);
    assert.deepEqual(state.decisions.get('feed_scanner'), decision);
  });

  it('isRoundComplete：设置预期 agents 后，全部 writeDecision 后返回 true', () => {
    const bb = new Blackboard();
    bb.setExpectedAgents(['feed_scanner', 'session_monitor']);
    assert.equal(bb.isRoundComplete(), false);
    bb.writeDecision({ agent: 'feed_scanner', action: 'pass', reason: '', confidence: 0, ts: 0 });
    assert.equal(bb.isRoundComplete(), false);
    bb.writeDecision({ agent: 'session_monitor', action: 'pass', reason: '', confidence: 0, ts: 0 });
    assert.equal(bb.isRoundComplete(), true);
  });

  it('reset：重置后 decisions 清空，finalCommand 为 null', () => {
    const bb = new Blackboard();
    bb.setExpectedAgents(['feed_scanner']);
    bb.writeDecision({ agent: 'feed_scanner', action: 'pass', reason: '', confidence: 0, ts: 0 });
    bb.setFinalCommand({ action: 'browse_next', reason: 'test' });
    bb.reset();
    const state = bb.getState();
    assert.equal(state.decisions.size, 0);
    assert.equal(state.finalCommand, null);
  });

  it('setFinalCommand：仲裁器写入最终命令', () => {
    const bb = new Blackboard();
    const cmd = { action: 'like' as const, reason: '干货', interaction: 'like' as const };
    bb.setFinalCommand(cmd);
    assert.deepEqual(bb.getState().finalCommand, cmd);
  });

  describe('EventBus 集成', () => {
    it('writeDecision 后触发 agent.decided 事件', () => {
      const eventBus = new EventBus();
      const bb = new Blackboard({ eventBus });
      bb.setExpectedAgents(['feed_scanner']);

      let emittedAgent: AgentRole | null = null;
      eventBus.on('agent.decided', (data) => { emittedAgent = data.agent; });

      bb.writeDecision({ agent: 'feed_scanner', action: 'open_note', reason: 'test', confidence: 0.8, ts: 0 });
      assert.equal(emittedAgent, 'feed_scanner');
    });

    it('isRoundComplete 时触发 round.complete', () => {
      const eventBus = new EventBus();
      const bb = new Blackboard({ eventBus });
      bb.setExpectedAgents(['feed_scanner', 'session_monitor']);

      let roundCompleted = false;
      eventBus.on('round.complete', () => { roundCompleted = true; });

      bb.writeDecision({ agent: 'feed_scanner', action: 'pass', reason: '', confidence: 0, ts: 0 });
      assert.equal(roundCompleted, false);
      bb.writeDecision({ agent: 'session_monitor', action: 'pass', reason: '', confidence: 0, ts: 0 });
      assert.equal(roundCompleted, true);
    });
  });
});
