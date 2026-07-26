import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSyncReadChangedSignal,
  SYNC_READ_CHANGED_STREAMS,
} from '../../src/kernel/sync-read-snapshot.js';

test('sync_read.changed parser accepts only the four automation runtime streams', () => {
  for (const stream of SYNC_READ_CHANGED_STREAMS) {
    assert.deepEqual(
      parseSyncReadChangedSignal(
        {
          contractVersion: 1,
          executionTarget: 'dev',
          stream,
          generation: '12',
        },
        { executionTarget: 'dev' },
      ),
      {
        contractVersion: 1,
        executionTarget: 'dev',
        stream,
        generation: '12',
      },
    );
  }
  assert.throws(
    () =>
      parseSyncReadChangedSignal({
        contractVersion: 1,
        executionTarget: 'dev',
        stream: 'session_config_global',
        generation: '12',
      }),
    /not an automation runtime stream/,
  );
});

test('sync_read.changed parser rejects open, malformed and cross-target signals', () => {
  const valid = {
    contractVersion: 1,
    executionTarget: 'dev',
    stream: 'edge_presence',
    generation: '12',
  };
  for (const input of [
    { ...valid, extra: true },
    { ...valid, contractVersion: 2 },
    { ...valid, executionTarget: 'unknown' },
    { ...valid, generation: 12 },
    { ...valid, generation: '012' },
  ]) {
    assert.throws(() => parseSyncReadChangedSignal(input));
  }
  assert.throws(
    () =>
      parseSyncReadChangedSignal(valid, {
        executionTarget: 'ol',
      }),
    /does not match ol/,
  );
});
