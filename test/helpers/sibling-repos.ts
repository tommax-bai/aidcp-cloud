// Sibling-repo resolution for the integration-test repo (change invert-split-fact-source).
//
// After the fact-source flip this repo no longer holds any business source; tests that
// read sibling repos' files AS DATA at runtime (not via import) resolve them here.
// Compile-time imports use the tsconfig `paths` aliases (@api/@automation/@content/@kernel)
// with the same dual-layout fallback; this helper is the runtime half of that contract.
//
// Resolution order (same convention as the control repo's sync-split-repos):
//   1. AIDCP_CODES_ROOT env var, when set — explicit codes root for isolated worktrees;
//   2. <repoRoot>/../<name>   — canonical layout (…/codes/aidcp-cloud);
//   3. <repoRoot>/../../<name> — linked-worktree layout (…/codes/aidcp-cloud.wt/<change>).
// A hit requires the candidate to contain a package.json. A miss THROWS loudly:
// silently reading an empty tree would be the exact silent-false-success this
// codebase red-lines.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUSINESS_REPOS = ['aidcp-api', 'aidcp-automation', 'aidcp-content'] as const;
export type BusinessRepo = (typeof BUSINESS_REPOS)[number];
export type OwnerLayer = 'api' | 'automation' | 'content' | 'kernel';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const OWNER_REPOS: Record<OwnerLayer, string> = {
  api: 'aidcp-api',
  automation: 'aidcp-automation',
  content: 'aidcp-content',
  kernel: 'aidcp-kernel',
};

export function siblingRepoRoot(name: string): string {
  const candidates: string[] = [];
  const codesRoot = process.env.AIDCP_CODES_ROOT;
  if (codesRoot) candidates.push(join(codesRoot, name));
  candidates.push(join(REPO_ROOT, '..', name));
  candidates.push(join(REPO_ROOT, '..', '..', name));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate);
  }
  throw new Error(
    `sibling repo ${name} not found (tried: ${candidates.join(', ')}). ` +
      'The integration suite requires sibling checkouts to be present and installed; ' +
      'set AIDCP_CODES_ROOT when running from an isolated worktree.'
  );
}

/** Absolute path of a source file that used to live at src/<srcRelPath> in the monolith. */
export function ownedSourcePath(owner: OwnerLayer, srcRelPath: string): string {
  return join(siblingRepoRoot(OWNER_REPOS[owner]), 'src', srcRelPath);
}

/** Absolute path of a sibling repo's migrations directory (union loaders enumerate all three). */
export function ownedMigrationsDir(repo: BusinessRepo): string {
  return join(siblingRepoRoot(repo), 'migrations');
}

/**
 * The union of the three business repos' composition roots — the derived-universe
 * replacement for reads of the monolith's `src/server.ts` (invert-split-fact-source 5.6
 * precedent). Per repo that is: `src/server.ts`, `src/index.ts`, plus the repo-private
 * top-level `src/<svc>-*.ts` composition/runtime files (e.g. automation-*.ts). These are
 * hand-written per repo and never synced, so "the machine wires X" claims must be asserted
 * against this union, not any single file.
 */
export function derivedCompositionRoots(): Array<{ repo: BusinessRepo; label: string; path: string }> {
  const roots: Array<{ repo: BusinessRepo; label: string; path: string }> = [];
  for (const repo of BUSINESS_REPOS) {
    const svc = repo.replace(/^aidcp-/, '');
    const srcDir = join(siblingRepoRoot(repo), 'src');
    for (const name of readdirSync(srcDir).sort()) {
      if (!name.endsWith('.ts')) continue;
      if (name === 'server.ts' || name === 'index.ts' || name.startsWith(`${svc}-`)) {
        roots.push({ repo, label: `${repo}/src/${name}`, path: join(srcDir, name) });
      }
    }
  }
  if (roots.length === 0) {
    throw new Error('derived_composition_roots_empty: no composition roots found in any sibling repo');
  }
  return roots;
}
