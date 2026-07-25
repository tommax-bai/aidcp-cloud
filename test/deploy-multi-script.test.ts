import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('multi-service deploy script braces variables adjacent to non-ASCII prose', async () => {
  const script = await readFile(
    resolve(repoRoot, 'deploy/multi-service/deploy-multi.sh'),
    'utf8',
  );

  assert.doesNotMatch(script, /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u);
});
