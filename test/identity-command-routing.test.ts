import assert from 'node:assert/strict';
import test from 'node:test';
import { edgeCommandToEnvelope } from '../src/comm/command-bridge.js';

test('identity EdgeCommand actions map to fixed protocol commands without target account fields', () => {
  const current = edgeCommandToEnvelope({
    action: 'identity_read_current',
    params: { captureId: 'capture-1' },
  });
  assert.equal(current.type, 'identity.read_current');
  assert.deepEqual(current.payload, { captureId: 'capture-1' });

  const selfProfile = edgeCommandToEnvelope({
    action: 'identity_read_self_profile',
    params: { captureId: 'capture-2' },
  });
  assert.equal(selfProfile.type, 'identity.read_self_profile');
  assert.deepEqual(selfProfile.payload, { captureId: 'capture-2' });
});
