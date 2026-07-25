/**
 * 验收用例 AC-LOCK-* — 数据库级 advisory lock 的归属检查
 * （change publish-approval-signal-to-database，task 5.5）
 *
 * 守护点：**每个 advisory lock 的 key 命名空间只能被单一服务边界内的源码引用**。
 * 跨服务的互斥绝不能用 advisory lock 表达——一旦两侧连到不同数据库或不同实例，
 * 两侧各自加锁都会成功、互斥消失，**且不产生任何错误**。它的失效方向是静默的，
 * 因此必须由自动化检查拦住，MUST NOT 只靠人工评审发现。
 *
 * 环境层级：离线 / 源码级（读本仓源码文本，不连库、不起服务）。
 *
 * **本文件只扫 `pg_advisory_*`，对行锁（`FOR UPDATE` / `FOR SHARE`）完全无感。**
 * 行锁的跨库失效同样无声，由同族的 `AC-LOCK-03/04/05` 承接，在 `row-lock-ownership.test.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * 服务边界目录（按 docs/cloud-service-decomposition-proposal.md 的拆分归属）。
 * 一个 key 前缀同时出现在两个不同边界里 = 跨服务共用锁 = 违规。
 */
const SERVICE_BOUNDARIES: ReadonlyArray<{ name: string; dirs: readonly string[] }> = [
  { name: 'api', dirs: ['client-auth', 'panel'] },
  // `risk` 由定稿 §4.7 归属表整目录判归 automation（19 文件 2478 行，`RiskController` 单写）。
  { name: 'automation', dirs: ['interactions', 'agents', 'orchestrator', 'publish-agent', 'comm', 'risk'] },
];

/** 单服务内使用的 key 前缀必须在此显式登记（连同其唯一拥有者目录）。 */
const SINGLE_SERVICE_KEYS: ReadonlyArray<{ prefix: string; ownerDir: string }> = [
  { prefix: 'interaction-send|', ownerDir: 'interactions' },
  // 收件箱批次幂等：key 由 `${platform}|${accountId}|${batchId}` 拼成，无固定文本前缀，
  // 以其唯一引用点所在目录登记。
  { prefix: 'payload.batchId', ownerDir: 'interactions' },
  // 每 executionTarget 单实例写者锁（change risk-state-cross-process-integrity）。
  // key = (AUTOMATION_WRITER_LOCK_NAME, executionTarget)，两个引用点都在 risk/writer-lock.ts。
  { prefix: 'AUTOMATION_WRITER_LOCK_NAME', ownerDir: 'risk' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function boundaryOf(relPath: string): string | null {
  const top = relPath.split('/')[0];
  for (const boundary of SERVICE_BOUNDARIES) {
    if (boundary.dirs.includes(top)) return boundary.name;
  }
  return null;
}

/** 收集全部 advisory lock 调用点：文件相对路径 + 行号 + 该行文本。 */
function collectAdvisoryLockSites(): Array<{ relPath: string; line: number; text: string }> {
  const sites: Array<{ relPath: string; line: number; text: string }> = [];
  for (const file of walk(SRC_ROOT)) {
    const relPath = file.slice(SRC_ROOT.length + 1);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      // 只看真正的调用，注释里提到锁名不算引用点。
      if (!/pg_advisory_/.test(text)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      // key 常写在调用的后续行（模板串参数换行），故连同紧随的两行一起作为该引用点的文本。
      sites.push({ relPath, line: index + 1, text: lines.slice(index, index + 3).join('\n') });
    });
  }
  return sites;
}

describe('AC-LOCK advisory lock 归属（绝不跨服务共用）', () => {
  it('AC-LOCK-01 跨服务边界的 interaction-env: 锁已被消除', () => {
    const sites = collectAdvisoryLockSites().filter((site) => site.text.includes('interaction-env:'));
    assert.deepEqual(
      sites,
      [],
      'interaction-env: 曾同时被 api（客户解绑）与 automation（登录态首写）引用；' +
        '拆库即静默失去互斥，必须改为 client_environments 的行锁。',
    );
  });

  it('AC-LOCK-02 每个 advisory lock 引用点都落在单一服务边界内且已登记', () => {
    const sites = collectAdvisoryLockSites();
    assert.ok(sites.length > 0, '若一处 advisory lock 都没有，本检查失去意义——请确认扫描路径');

    const boundaries = new Set<string>();
    for (const site of sites) {
      const boundary = boundaryOf(site.relPath);
      assert.notEqual(
        boundary,
        null,
        `advisory lock 出现在未归属服务边界的目录：${site.relPath}:${site.line}`,
      );
      boundaries.add(boundary!);
      const registered = SINGLE_SERVICE_KEYS.some(
        (key) => site.text.includes(key.prefix) && site.relPath.startsWith(`${key.ownerDir}/`),
      );
      assert.ok(
        registered,
        `未登记的 advisory lock 引用点 ${site.relPath}:${site.line}：` +
          '单服务内使用的 key 必须在 SINGLE_SERVICE_KEYS 显式登记，跨服务互斥必须改用所有者服务的行锁。',
      );
    }
    assert.deepEqual(
      [...boundaries],
      ['automation'],
      '当前全部 advisory lock 只应活在 automation 边界内；出现第二个边界即为跨界共用。',
    );
  });
});
