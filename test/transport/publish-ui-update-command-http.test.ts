import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_CONTRACT_VERSION,
  type PublishUiUpdateCommandInput,
} from '@kernel/kernel/api-direct-port.js';
import { ApiDirectHttpError } from '@automation/transport/api-direct-http-common.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  PUBLISH_UI_UPDATE_COMMAND_ROUTES,
  PublishUiUpdateCommandHttpClient,
  registerPublishUiUpdateCommandRoutes,
} from '@automation/transport/paired-command-http.js';

const TOKEN = 'automation-command-token';

function stateCommand(commandId = 'publish-ui-1'): PublishUiUpdateCommandInput {
  return {
    commandId,
    accountId: 'acct-1',
    update: {
      kind: 'state',
      recordId: 41,
      state: 'submitted',
      factVersion: 8,
      title: '标题',
    },
  };
}

test('publish UI command transport preserves request and owner receipt', async () => {
  const received: PublishUiUpdateCommandInput[] = [];
  const server = new InternalHttpServer();
  registerPublishUiUpdateCommandRoutes(
    server,
    {
      async applyPublishUiUpdate(input) {
        received.push(input);
        return {
          outcome: 'applied',
          commandId: input.commandId,
          accountId: input.accountId,
        };
      },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const client = new PublishUiUpdateCommandHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      TOKEN,
      'dev',
    );
    const command: PublishUiUpdateCommandInput = {
      commandId: 'preview-roundtrip',
      accountId: 'acct-1',
      update: {
        kind: 'preview',
        preview: {
          id: 41,
          accountId: 'acct-1',
          platform: 'facebook',
          kind: 'rewrite',
          title: null,
          content: '',
          topics: [],
          images: [],
          contentVersion: 0,
          updatedAt: 1_750_000_000_000,
          publishMode: 'immediate',
          publishTime: null,
        },
      },
    };
    assert.deepEqual(await client.applyPublishUiUpdate(command), {
      outcome: 'applied',
      commandId: 'preview-roundtrip',
      accountId: 'acct-1',
    });
    assert.deepEqual(received, [command]);
  } finally {
    await server.close();
  }
});

test('publish UI command transport preserves state fact version and stale receipt', async () => {
  let received: PublishUiUpdateCommandInput | undefined;
  const server = new InternalHttpServer();
  registerPublishUiUpdateCommandRoutes(
    server,
    {
      async applyPublishUiUpdate(input) {
        received = input;
        return {
          outcome: 'stale',
          commandId: input.commandId,
          accountId: input.accountId,
        };
      },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const client = new PublishUiUpdateCommandHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      TOKEN,
      'dev',
    );
    const input = stateCommand('state-v8');
    assert.deepEqual(await client.applyPublishUiUpdate(input), {
      outcome: 'stale',
      commandId: 'state-v8',
      accountId: 'acct-1',
    });
    assert.deepEqual(received, input);
  } finally {
    await server.close();
  }
});

test('publish UI route rejects auth, version, target, and account mismatch before owner call', async () => {
  let calls = 0;
  const server = new InternalHttpServer();
  registerPublishUiUpdateCommandRoutes(
    server,
    {
      async applyPublishUiUpdate(input) {
        calls += 1;
        return {
          outcome: 'applied',
          commandId: input.commandId,
          accountId: input.accountId,
        };
      },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const base = {
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input: stateCommand(),
    };
    for (const invoke of [
      () => http.callBearer(
        PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
        base,
        'wrong-token',
      ),
      () => http.callBearer(
        PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
        { ...base, version: 2 },
        TOKEN,
      ),
      () => http.callBearer(
        PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
        { ...base, executionTarget: 'ol' },
        TOKEN,
      ),
      () => http.callBearer(
        PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
        {
          ...base,
          input: {
            commandId: 'preview-mismatch',
            accountId: 'acct-1',
            update: {
              kind: 'preview',
              preview: {
                id: 1,
                accountId: 'acct-2',
                platform: 'xiaohongshu',
                kind: 'generated',
                title: null,
                content: '',
                topics: [],
                images: [],
                contentVersion: 0,
                updatedAt: 1,
                publishMode: 'draft',
                publishTime: null,
              },
            },
          },
        },
        TOKEN,
      ),
      () => http.callBearer(
        PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
        {
          ...base,
          input: {
            ...stateCommand('state-without-fact-version'),
            update: {
              kind: 'state',
              recordId: 41,
              state: 'submitted',
            },
          },
        },
        TOKEN,
      ),
    ]) {
      await assert.rejects(
        invoke,
        (error: unknown) =>
          error instanceof InternalHttpError &&
          (
            error.code === 'internal_http_unauthorized' ||
            error.code === 'api_direct_version_unsupported' ||
            error.code === 'api_direct_target_mismatch' ||
            error.code === 'api_direct_invalid_request'
          ),
      );
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('publish UI client binds every receipt to commandId and accountId', async () => {
  for (const malformed of [
    {
      outcome: 'applied',
      commandId: 'different-command',
      accountId: 'acct-1',
    },
    {
      outcome: 'collision',
      commandId: 'publish-ui-1',
      accountId: 'different-account',
    },
    {
      outcome: 'stale',
      commandId: 'publish-ui-1',
      accountId: 'different-account',
    },
  ]) {
    const server = new InternalHttpServer();
    server.registerBearer(
      PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
      TOKEN,
      async () => malformed,
    );
    const port = await server.listen(0);
    try {
      const client = new PublishUiUpdateCommandHttpClient(
        new InternalHttpClient(`http://127.0.0.1:${port}`),
        TOKEN,
        'dev',
      );
      await assert.rejects(
        () => client.applyPublishUiUpdate(stateCommand()),
        (error: unknown) =>
          error instanceof ApiDirectHttpError &&
          error.code === 'publish_ui_update_result_unknown',
      );
    } finally {
      await server.close();
    }
  }
});

test('publish UI client reports unknown and does not retry when response is lost', async () => {
  let calls = 0;
  const server = new InternalHttpServer();
  server.registerBearer(
    PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
    TOKEN,
    async () => {
      calls += 1;
      throw new Error('response_lost_after_apply');
    },
  );
  const port = await server.listen(0);
  try {
    const client = new PublishUiUpdateCommandHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      TOKEN,
      'dev',
    );
    await assert.rejects(
      () => client.applyPublishUiUpdate(stateCommand()),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'publish_ui_update_result_unknown',
    );
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
