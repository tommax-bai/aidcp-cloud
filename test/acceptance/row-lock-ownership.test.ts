/**
 * 验收用例 `AC-LOCK-03..05` —— **行锁**（`FOR UPDATE` / `FOR SHARE` 及其变体）的归属门禁。
 *
 * 与同族的 `AC-LOCK-01/02`（advisory-lock-ownership.test.ts）互补：那两条只扫 `pg_advisory_*`，
 * 对行锁完全无感。而行锁的跨库失效与 advisory lock 一样是**无声的** —— 两侧连到不同库时，
 * 两边各自加锁都会成功、互斥消失、且不产生任何错误（同一教训写在 `src/db/environment-row-lock.ts` 文件头）。
 * 无声失效 MUST 由自动化拦住，MUST NOT 指望人工评审看见。
 *
 * 判据一律外取，本文件不自立：
 *   - 表属主 → `boundaries/table-ownership.json`（§5.1 单一写入者）。**MUST NOT 按目录位置猜属主**：
 *     `src/interactions/` 下就有两个 store 碰的表全是 api 属主，按目录猜会整片判反。
 *   - 文件归属 → `boundaries/ownership-rules.json` 展开出的 `boundaries/module-ownership.json`（§4.7）。
 *   - 已知违规 → `boundaries/row-lock-exemptions.json`（只减不增的棘轮清单）。
 *
 * 环境层级：离线 / 源码级（只读源码与清单文件，不连库、不起服务）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Layer,
  type RowLockExemption,
  boundarySnapshot,
  readJson,
  scanRowLockSource,
} from './helpers/boundary-scan.js';

const EXEMPTIONS_PATH = 'boundaries/row-lock-exemptions.json';

interface BorrowedHelper {
  file: string;
  fileLayer: Layer;
  tables: string[];
  knownCallerLayers: string[];
  reason: string;
  eliminatedBy: string | null;
  note?: string;
}

interface RowLockExemptionFile {
  sourceOfTruth: string;
  seedTotal: number;
  seedUnplanned: number;
  frozenTotal: number;
  recordedAt: string;
  seedBasis?: string;
  raises: { amount: number; approvedByChange: string; eliminateBy: string }[];
  entries: RowLockExemption[];
  borrowedConnectionHelpers: { why: string; frozenTotal: number; files: BorrowedHelper[] };
}

const snapshot = boundarySnapshot();
const exemptions = readJson<RowLockExemptionFile>(EXEMPTIONS_PATH);

interface Violation {
  file: string;
  line: number;
  table: string;
  kind: string;
  locker: Layer;
  owner: Layer;
  clause: string;
}

const violations: Violation[] = [];
/** 加锁方归属或表属主查不到的行锁点 —— MUST 报出来判失败，MUST NOT 静默丢弃（漏报＝门禁形同虚设）。 */
const unresolved: string[] = [];
for (const site of snapshot.rowLocks.sites) {
  const locker = snapshot.ownership.get(site.file);
  for (const table of site.tables) {
    const owner = snapshot.tableOwners.get(table);
    if (!locker || !owner) {
      unresolved.push(
        `${site.file}:${site.line} ${table}${owner ? '' : '（表无属主）'}${locker ? '' : '（加锁方无归属）'}`,
      );
      continue;
    }
    if (locker === owner) continue;
    violations.push({ file: site.file, line: site.line, table, kind: site.kind, locker, owner, clause: site.clause });
  }
}

const exemptionKey = (e: { file: string; table: string; kind: string }): string => `${e.file} ${e.table} ${e.kind}`;
const exemptionIndex = new Set(exemptions.entries.map(exemptionKey));
const describeViolation = (v: Violation): string =>
  `${v.file}:${v.line} ${v.locker}->${v.owner} 锁 ${v.table}（${v.clause}）`;

const unexempted = violations.filter((v) => !exemptionIndex.has(exemptionKey(v)));
const liveKeys = new Set(violations.map(exemptionKey));
const stale = exemptions.entries.filter((e) => !liveKeys.has(exemptionKey(e)));

console.log(
  `AC-LOCK row-lock metrics ${JSON.stringify({
    lockSites: snapshot.rowLocks.sites.length,
    crossOwnerSites: violations.length,
    crossOwnerKeys: liveKeys.size,
    exemptions: exemptions.entries.length,
    frozenTotal: exemptions.frozenTotal,
    borrowedConnectionFiles: [...new Set(snapshot.rowLocks.sites.filter((s) => s.borrowedConnection).map((s) => s.file))],
  })}`,
);

describe('AC-LOCK 行锁归属（跨属主的行锁必须登记，新增即失败）', () => {
  it('AC-LOCK-03 没有清单外的跨属主行锁', () => {
    assert.deepEqual(
      snapshot.rowLocks.unlexed,
      [],
      '有 FOR UPDATE / FOR SHARE 落在任何字符串字面量之外：扫描器没看懂这处源码，' +
        '此时「无违规」等于「没看见」。MUST 修扫描器，MUST NOT 放过。',
    );
    assert.deepEqual(
      snapshot.rowLocks.tableless,
      [],
      '有行锁语句一张表都认不出来：同上，MUST NOT 当作「没跨界」放过。',
    );
    assert.deepEqual(unresolved, [], '行锁点的加锁方归属或表属主查不到，MUST 先把归属判据补齐再谈门禁');

    assert.deepEqual(
      unexempted.map(describeViolation),
      [],
      `出现 ${EXEMPTIONS_PATH} 里没有的跨属主行锁。跨库行锁的失效是无声的（两侧各自加锁都成功、互斥消失、不报错），` +
        '故处置顺序是：① 先查是不是归属填错了（多数「新违规」其实是新文件的归属层没按 §4.7 判对）；' +
        '② 把这条跨属主行锁改成属主侧自己的事务 / 端口调用；③ 确需冻结才走控制仓 change 追加豁免条目并写清 reason 与去向。',
    );
  });

  it('AC-LOCK-03b 豁免清单只减不增（条数不超过登记值，且没有已消失的僵尸条目）', () => {
    assert.deepEqual(
      stale.map((e) => `${exemptionKey(e)}（${e.direction}）`),
      [],
      `${EXEMPTIONS_PATH} 里有源码中已不存在的条目。违规消失是好事，但条目 MUST 手工删掉并把 frozenTotal 一起调低——` +
        '留着它就是给未来同一处违规预留了一张免检票。',
    );
    assert.ok(
      exemptions.entries.length <= exemptions.frozenTotal,
      `豁免条数 ${exemptions.entries.length} 超过冻结值 ${exemptions.frozenTotal}：棘轮只许下调。`,
    );
    assert.ok(
      exemptions.frozenTotal <= exemptions.seedTotal,
      `frozenTotal ${exemptions.frozenTotal} 超过 seedTotal ${exemptions.seedTotal}，且 raises[] 为空时无上调通道。`,
    );
    assert.ok((exemptions.seedBasis ?? '').trim() !== '', 'seedBasis 是 seed 基线为什么是这个数的唯一在仓记录，MUST 非空');
    for (const entry of exemptions.entries) {
      assert.ok(entry.reason.trim() !== '', `豁免条目 ${exemptionKey(entry)} 缺 reason`);
      assert.ok(entry.direction.includes('->'), `豁免条目 ${exemptionKey(entry)} 的 direction MUST 写成 <加锁方>-><表属主>`);
    }
  });

  it('AC-LOCK-04 借调调用方连接的行锁点全部已登记', () => {
    // 这类文件自己不建池、不 connect()，锁跑在调用方事务上；调用方常由组合根按结构类型注入，
    // 连 import 边都没有 —— 光看「文件属于哪一层」判不出跨界，AC-LOCK-03 对它天然失明。
    const detected = [...new Set(snapshot.rowLocks.sites.filter((s) => s.borrowedConnection).map((s) => s.file))].sort();
    const registered = exemptions.borrowedConnectionHelpers.files.map((f) => f.file).sort();
    assert.deepEqual(
      detected,
      registered,
      `借调式行锁点的实测集合与 ${EXEMPTIONS_PATH} 的登记集合不一致。` +
        '新增一个未登记的借调式加锁点 MUST 当场失败：它跑在谁的事务里只有人知道，MUST 由人写进清单。',
    );
    assert.equal(
      registered.length,
      exemptions.borrowedConnectionHelpers.frozenTotal,
      '借调式加锁点的登记条数 MUST 与 frozenTotal 相等（只减不增，减少时一并下调）。',
    );
    for (const helper of exemptions.borrowedConnectionHelpers.files) {
      assert.ok(helper.knownCallerLayers.length > 0, `${helper.file} MUST 写明已知调用方在哪一层`);
      assert.ok(helper.reason.trim() !== '', `${helper.file} 缺 reason`);
    }
  });

  it('AC-LOCK-05 扫描器保真自检（多行 / 模板串 / 别名 / 注释）', () => {
    const known = new Set(['accounts', 'client_environments', 'interaction_auth_state']);
    const scan = (source: string) => scanRowLockSource('probe.ts', source, known);

    // ① 表名与 FOR UPDATE 分处不同行的模板串：多行 SQL 是本仓主流写法，认不出来就等于整族失明。
    const multiline = scan([
      'const q = await this.pool.query(`SELECT 1 FROM accounts',
      "  WHERE account_id=$1",
      '  FOR UPDATE`, [id]);',
    ].join('\n'));
    assert.deepEqual(multiline.sites.map((s) => [s.line, s.kind, s.tables]), [[3, 'update', ['accounts']]]);

    // ② FOR SHARE OF <别名>：只锁点名的那几张表。
    const aliased = scan(
      'const q = await this.pool.query(`SELECT 1 FROM accounts a JOIN interaction_auth_state s ON s.account_id=a.account_id FOR SHARE OF s`);',
    );
    assert.deepEqual(aliased.sites.map((s) => [s.kind, s.tables]), [['share', ['interaction_auth_state']]]);

    // ③ 别名认不出来（这里 t 未在 FROM 里声明）时 MUST 退回「语句里全部表」，宁可误报绝不漏报。
    const unknownAlias = scan(
      'const q = await this.pool.query(`SELECT 1 FROM accounts JOIN interaction_auth_state ON true FOR UPDATE OF t SKIP LOCKED`);',
    );
    assert.deepEqual(unknownAlias.sites.map((s) => s.tables), [['accounts', 'interaction_auth_state']]);

    // ④ 注释里的 FOR UPDATE 不是引用点；插值段不得让行号漂移。
    const commented = scan([
      '// 说明：这里以前是 SELECT ... FOR UPDATE',
      '/* 块注释里的 FOR SHARE 同样不算 */',
      'const q = await this.pool.query(`SELECT 1 FROM ${table} WHERE a=$1`);',
      'const r = await this.pool.query(`SELECT 1 FROM client_environments WHERE env_key=$1 FOR NO KEY UPDATE`);',
    ].join('\n'));
    assert.deepEqual(commented.sites.map((s) => [s.line, s.kind, s.tables]), [[4, 'no_key_update', ['client_environments']]]);

    // ⑤ 自持连接的判据：有 connect()/池字段 = 自己的事务；一处都没有 = 借调调用方句柄。
    assert.equal(
      scan('async function f(client: Q) { await client.query(`SELECT 1 FROM accounts FOR UPDATE`); }').sites[0]
        .borrowedConnection,
      true,
    );
    assert.equal(multiline.sites[0].borrowedConnection, false);
  });
});
