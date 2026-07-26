import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PendingPublishPreview,
  PublishUiUpdateCommandInput,
  PublishUiUpdateCommandPort,
} from '../../src/kernel/api-direct-port.js';
import {
  createPublishUiUpdateProducer,
  PublishUiUpdateProducerError,
} from '../../src/publish-agent/publish-ui-update-producer.js';

const preview: PendingPublishPreview = {
  id: 41,
  accountId: 'account-1',
  platform: 'xiaohongshu',
  kind: 'generated',
  title: 'title',
  content: 'body',
  topics: ['topic'],
  images: [],
  contentVersion: 7,
  updatedAt: 1_700_000_000_000,
  publishMode: 'immediate',
  publishTime: null,
};

function command(
  apply: PublishUiUpdateCommandPort['applyPublishUiUpdate'],
): PublishUiUpdateCommandPort {
  return { applyPublishUiUpdate: apply };
}

test('preview producer reads owner state before sending one stable command', async () => {
  const order: string[] = [];
  let sent: PublishUiUpdateCommandInput | undefined;
  const producer = createPublishUiUpdateProducer({
    loadPreview: async (recordId) => {
      order.push(`read:${recordId}`);
      return preview;
    },
    command: command(async (input) => {
      order.push(`send:${input.commandId}`);
      sent = input;
      return {
        outcome: 'applied',
        commandId: input.commandId,
        accountId: input.accountId,
      };
    }),
  });

  const result = await producer.pushPreview(41);

  assert.deepEqual(order, ['read:41', 'send:publish-ui:preview:41:7']);
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(sent, {
    commandId: 'publish-ui:preview:41:7',
    accountId: 'account-1',
    update: { kind: 'preview', preview },
  });
});

test('preview producer preserves no-record and sends no command', async () => {
  let sends = 0;
  const producer = createPublishUiUpdateProducer({
    loadPreview: async () => null,
    command: command(async () => {
      sends += 1;
      throw new Error('must not send');
    }),
  });

  assert.deepEqual(await producer.pushPreview(404), {
    outcome: 'no_record',
    recordId: 404,
  });
  assert.equal(sends, 0);
});

test('preview producer preserves owner-read failure', async () => {
  const readFailure = new Error('owner_read_failed');
  const producer = createPublishUiUpdateProducer({
    loadPreview: async () => {
      throw readFailure;
    },
    command: command(async () => {
      throw new Error('must not send');
    }),
  });

  await assert.rejects(producer.pushPreview(41), (error) => error === readFailure);
});

test('preview producer preserves duplicate receipt and rejects collision', async () => {
  const duplicate = createPublishUiUpdateProducer({
    loadPreview: async () => preview,
    command: command(async (input) => ({
      outcome: 'duplicate',
      commandId: input.commandId,
      accountId: input.accountId,
    })),
  });
  assert.equal((await duplicate.pushPreview(41)).outcome, 'duplicate');

  const collision = createPublishUiUpdateProducer({
    loadPreview: async () => preview,
    command: command(async (input) => ({
      outcome: 'collision',
      commandId: input.commandId,
      accountId: input.accountId,
    })),
  });
  await assert.rejects(
    collision.pushPreview(41),
    (error: unknown) =>
      error instanceof PublishUiUpdateProducerError &&
      error.code === 'publish_ui_update_command_collision',
  );
});

test('preview producer preserves post-send result-unknown without retry', async () => {
  let calls = 0;
  const unknown = Object.assign(new Error('ack lost'), {
    code: 'publish_ui_update_result_unknown',
  });
  const producer = createPublishUiUpdateProducer({
    loadPreview: async () => preview,
    command: command(async () => {
      calls += 1;
      throw unknown;
    }),
  });

  await assert.rejects(unknownProducerCall(producer), (error) => error === unknown);
  assert.equal(calls, 1);
});

async function unknownProducerCall(
  producer: ReturnType<typeof createPublishUiUpdateProducer>,
): Promise<unknown> {
  return producer.pushPreview(41);
}

test('state producer uses fact version and preserves applied receipt', async () => {
  let sent: PublishUiUpdateCommandInput | undefined;
  const producer = createPublishUiUpdateProducer({
    loadPreview: async () => {
      throw new Error('state push must not read preview');
    },
    command: command(async (input) => {
      sent = input;
      return {
        outcome: 'applied',
        commandId: input.commandId,
        accountId: input.accountId,
      };
    }),
  });

  assert.equal(
    (await producer.pushState('account-1', 41, 'rejected', 9, 'title')).outcome,
    'applied',
  );
  assert.deepEqual(sent, {
    commandId: 'publish-ui:state:41:rejected:9',
    accountId: 'account-1',
    update: {
      kind: 'state',
      recordId: 41,
      state: 'rejected',
      factVersion: 9,
      title: 'title',
    },
  });
});
