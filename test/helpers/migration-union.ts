// Migration union over the three business repos (change invert-split-fact-source, task 5.3).
//
// After the fact-source flip this repo's migrations/ is a frozen historical record; the
// LIVE migration set is the union of aidcp-api / aidcp-automation / aidcp-content
// migrations/. Tests that used to read `../../migrations/<name>.sql` resolve through here.
//
// Union rules (pilot-validated):
//   - dedup by filename;
//   - a filename present in more than one repo MUST have byte-identical content in all of
//     them — a divergent copy means the shared DB history has silently forked, and failing
//     loudly here is the point of the union (do not weaken this to "first wins");
//   - ordering follows the executor's own compareVersions logic, not lexical sort.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadMigrationFiles, checksumOf } from '@automation/schema/migration-files.js';
import { compareVersions, versionOf, type MigrationFile } from '@automation/schema/migration-plan.js';

import { BUSINESS_REPOS, ownedMigrationsDir } from './sibling-repos.js';

/** The deduplicated, checksum-verified, version-ordered union of the three repos' migrations. */
export async function unionMigrationFiles(): Promise<MigrationFile[]> {
  const byName = new Map<string, { file: MigrationFile; repos: string[] }>();
  for (const repo of BUSINESS_REPOS) {
    const files = await loadMigrationFiles(ownedMigrationsDir(repo));
    for (const file of files) {
      const existing = byName.get(file.name);
      if (!existing) {
        byName.set(file.name, { file, repos: [repo] });
        continue;
      }
      if (existing.file.checksum !== file.checksum) {
        throw new Error(
          `migration_union_divergent_copy ${file.name}: ${existing.repos.join(',')} and ${repo} ` +
            'hold different bytes for the same migration filename. Shared DB history has forked; ' +
            'reconcile the copies before trusting any union-based assertion.',
        );
      }
      existing.repos.push(repo);
    }
  }
  return [...byName.values()]
    .map((entry) => entry.file)
    .sort((a, b) => compareVersions(versionOf(a.name), versionOf(b.name)));
}

/** Union filenames only (\*.sql), version-ordered. */
export async function unionMigrationNames(): Promise<string[]> {
  return (await unionMigrationFiles()).map((file) => file.name);
}

/**
 * Read one named migration from wherever it now lives. A miss THROWS loudly (a silently
 * empty string would green-light every doesNotMatch assertion in the caller); copies in
 * several repos MUST agree byte-for-byte.
 */
export async function readMigration(name: string): Promise<string> {
  const found: { repo: string; content: string; checksum: string }[] = [];
  for (const repo of BUSINESS_REPOS) {
    const candidate = join(ownedMigrationsDir(repo), name);
    if (!existsSync(candidate)) continue;
    const content = await readFile(candidate, 'utf8');
    found.push({ repo, content, checksum: checksumOf(content) });
  }
  if (found.length === 0) {
    throw new Error(
      `migration_not_found ${name}: not present in any of ${BUSINESS_REPOS.join(', ')}. ` +
        'The cloud migrations/ copy is frozen history, not a fallback — fix the name or the split.',
    );
  }
  const [first, ...rest] = found;
  for (const other of rest) {
    if (other.checksum !== first!.checksum) {
      throw new Error(
        `migration_union_divergent_copy ${name}: ${first!.repo} and ${other.repo} disagree. ` +
          'Shared DB history has forked; reconcile before asserting on either copy.',
      );
    }
  }
  return first!.content;
}
