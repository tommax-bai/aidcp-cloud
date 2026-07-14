/**
 * 安装包清单（change downloads-manifest-from-host）。
 * 红线：页面只可能提供**确实存在**的文件；没有包时诚实为空，绝不编造版本、绝不给未经证实的链接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDownloadsManifest, compareVersions, readDownloadsManifest } from '../../src/panel/downloads-manifest.js';

// dev 机 /opt/aidcp/downloads 的真实内容（含历史包与 .bak 残留）——直接拿真机目录当夹具。
const DEV_DIR_SAMPLE = [
  'AIDCP-0.1.0-arm64.dmg',
  'AIDCP-0.1.0.dmg',
  'AIDCP-0.2.4-arm64.dmg',
  'AIDCP-0.2.4-arm64.dmg.bak-20260706-110723',
  'AIDCP-0.2.4.dmg',
  'AIDCP-0.2.4.dmg.bak-20260706-110723',
  'AIDCP-0.3.5-arm64.dmg',
  'AIDCP-0.3.5.dmg',
  'AIDCP-0.3.18-arm64.dmg',
  'AIDCP-0.3.18.dmg',
  'AIDCP Setup 0.3.3.exe',
  'AIDCP Setup 0.3.5.exe',
  'AIDCP Setup 0.3.2.exe.bak-20260710-113144',
  'desktop-20260704-164629',
];

test('downloads: 同平台多版本共存 → 取最高语义版本（0.3.18 > 0.3.5，非字典序）', () => {
  const m = buildDownloadsManifest(DEV_DIR_SAMPLE);
  assert.equal(m.version, '0.3.18');
  assert.deepEqual(
    m.items.map((i) => [i.key, i.file]),
    [
      ['mac-arm64', 'AIDCP-0.3.18-arm64.dmg'],
      ['mac-x64', 'AIDCP-0.3.18.dmg'],
      ['win-x64', 'AIDCP Setup 0.3.5.exe'],
    ],
  );
});

test('downloads: 备份 / 残留文件绝不被当成发布包', () => {
  const m = buildDownloadsManifest(DEV_DIR_SAMPLE);
  for (const item of m.items) {
    assert.doesNotMatch(item.file, /\.bak/, '备份文件不得出现在清单里');
  }
  // 只有 .bak 备份、没有真包时 = 没有可下载的包。
  const onlyBackups = buildDownloadsManifest(['AIDCP-0.2.4.dmg.bak-20260706-110723', 'desktop-20260704-164629']);
  assert.deepEqual(onlyBackups, { version: null, items: [] });
});

test('downloads: 目录为空 / 无可识别包 → 诚实空清单（绝不编造版本号）', () => {
  assert.deepEqual(buildDownloadsManifest([]), { version: null, items: [] });
  assert.deepEqual(buildDownloadsManifest(['README.md', 'notes.txt']), { version: null, items: [] });
});

test('downloads: 目录不存在 / 不可读 → 诚实空清单，不抛（「这台机器上没有包」是合法事实）', async () => {
  const m = await readDownloadsManifest('/nonexistent/aidcp/downloads');
  assert.deepEqual(m, { version: null, items: [] });
});

test('downloads: 两台机器各说各的真话（同一份代码，目录不同 → 清单不同）', () => {
  const dev = buildDownloadsManifest(['AIDCP-0.3.18-arm64.dmg', 'AIDCP-0.3.18.dmg']);
  const ol = buildDownloadsManifest(['AIDCP-0.3.20-arm64.dmg', 'AIDCP-0.3.20.dmg']);
  assert.equal(dev.version, '0.3.18');
  assert.equal(ol.version, '0.3.20');
});

test('downloads: 只有 Windows 包时也能给出版本（不因缺 mac 包而谎称为空）', () => {
  const m = buildDownloadsManifest(['AIDCP Setup 0.3.5.exe']);
  assert.equal(m.version, '0.3.5');
  assert.equal(m.items.length, 1);
});

test('downloads: 版本比较按语义段而非字典序', () => {
  assert.ok(compareVersions('0.3.18', '0.3.5') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});
