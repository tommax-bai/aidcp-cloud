import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PersonaGeneratorCommandReceiver,
  PersonaGeneratorReceiptCapacityError,
} from '@content/llm/persona-generator-command-receiver.js';
import type { PersonaGenerateOutcome } from '@kernel/kernel/persona-ports.js';

const GENERATED: PersonaGenerateOutcome = {
  ok: true,
  soulYaml: 'identity:\n  name: Alice\n',
  identitySummary: 'Alice',
};

test('PersonaGeneratorCommandReceiver returns and reuses the content owner result', async () => {
  let generations = 0;
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      generations++;
      return GENERATED;
    },
  });
  const input = {
    idempotencyKey: 'persona-1',
    accountId: 'acct-1',
    keywordSelections: ['咖啡'],
    diversitySeed: 'seed-1',
  };

  assert.deepEqual(await receiver.generate(input), {
    outcome: 'applied',
    idempotencyKey: 'persona-1',
    result: GENERATED,
  });
  assert.deepEqual(await receiver.generate(input), {
    outcome: 'duplicate',
    idempotencyKey: 'persona-1',
    result: GENERATED,
  });
  assert.equal(generations, 1);
});

test('PersonaGeneratorCommandReceiver rejects colliding payloads', async () => {
  let generations = 0;
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      generations++;
      return GENERATED;
    },
  });

  await receiver.generate({
    idempotencyKey: 'persona-collision',
    accountId: 'acct-1',
    keywordSelections: ['咖啡'],
  });
  assert.deepEqual(
    await receiver.generate({
      idempotencyKey: 'persona-collision',
      accountId: 'acct-1',
      keywordSelections: ['美妆'],
    }),
    { outcome: 'collision', idempotencyKey: 'persona-collision' },
  );
  assert.equal(generations, 1);
});

test('PersonaGeneratorCommandReceiver coalesces concurrent equivalent generations', async () => {
  let generations = 0;
  let release!: (result: PersonaGenerateOutcome) => void;
  const pending = new Promise<PersonaGenerateOutcome>((resolve) => {
    release = resolve;
  });
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      generations++;
      return pending;
    },
  });
  const input = {
    idempotencyKey: 'persona-concurrent',
    accountId: 'acct-1',
    keywordSelections: ['咖啡'],
  };

  const first = receiver.generate(input);
  const duplicate = receiver.generate(input);
  release(GENERATED);

  assert.equal((await first).outcome, 'applied');
  assert.equal((await duplicate).outcome, 'duplicate');
  assert.equal(generations, 1);
});

test('PersonaGeneratorCommandReceiver does not cache a thrown generation result', async () => {
  let generations = 0;
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      generations++;
      if (generations === 1) throw new Error('model_ack_unknown');
      return { ok: false, reason: 'generation_failed' };
    },
  });
  const input = {
    idempotencyKey: 'persona-unknown',
    accountId: 'acct-1',
    keywordSelections: ['咖啡'],
  };

  await assert.rejects(receiver.generate(input), /model_ack_unknown/);
  assert.deepEqual(await receiver.generate(input), {
    outcome: 'applied',
    idempotencyKey: 'persona-unknown',
    result: { ok: false, reason: 'generation_failed' },
  });
  assert.equal(generations, 2);
});

test('PersonaGeneratorCommandReceiver fails closed at capacity and retains old receipts', async () => {
  let generations = 0;
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      generations++;
      return GENERATED;
    },
  });
  for (let index = 0; index < 1_024; index++) {
    await receiver.generate({
      idempotencyKey: `persona-capacity-${index}`,
      accountId: 'acct-1',
      keywordSelections: ['咖啡'],
    });
  }

  await assert.rejects(
    receiver.generate({
      idempotencyKey: 'persona-capacity-overflow',
      accountId: 'acct-1',
      keywordSelections: ['咖啡'],
    }),
    PersonaGeneratorReceiptCapacityError,
  );
  assert.equal(
    (await receiver.generate({
      idempotencyKey: 'persona-capacity-0',
      accountId: 'acct-1',
      keywordSelections: ['咖啡'],
    })).outcome,
    'duplicate',
  );
  assert.equal(generations, 1_024);
});
