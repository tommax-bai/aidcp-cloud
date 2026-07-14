/**
 * 边缘桌面安装包清单（change downloads-manifest-from-host）。
 *
 * 红线：安装包版本**不是源码，是部署状态**——它描述「这台机器的 downloads 目录里放了哪个包」，
 * 每台机器各不相同。写死在 console 源码里，就保证了它对除了一台之外的所有机器都是谎话
 * （主干指向 ol 的包 → dev 下载页给死链；主干指向 dev 的包 → ol 下载页被回退）。
 * 故此处**现扫该机目录**得出清单：页面只可能提供确实存在的文件，死链在构造上不可能。
 *
 * 扫不到 / 目录不存在 / 没有可识别的包 → 诚实返回空清单，由前端显示「暂无可用安装包」；
 * 绝不编造版本号、绝不回落到写死值（宁缺毋假）。
 */

import { readdir } from 'node:fs/promises';

/** 面板暴露的单个安装包条目。 */
export interface DownloadItem {
  /** 平台键（前端按此排序/取图标）。 */
  key: 'mac-arm64' | 'mac-x64' | 'win-x64';
  /** 人类可读平台名。 */
  label: string;
  /** 该机 downloads 目录下的真实文件名。 */
  file: string;
  /** 从文件名解析出的版本。 */
  version: string;
}

export interface DownloadsManifest {
  /** 展示用主版本（取 mac 包版本；无 mac 包时取任一最高版本）；无任何包时为 null。 */
  version: string | null;
  items: DownloadItem[];
}

const PLATFORM_LABELS: Record<DownloadItem['key'], string> = {
  'mac-arm64': 'macOS · Apple 芯片（M 系列）',
  'mac-x64': 'macOS · Intel',
  'win-x64': 'Windows · x64',
};

/** 发布包文件名规则（与 electron-builder 产物一致）。备份 / 残留一律不匹配。 */
const PATTERNS: Array<{ key: DownloadItem['key']; re: RegExp }> = [
  { key: 'mac-arm64', re: /^AIDCP-(\d+\.\d+\.\d+)-arm64\.dmg$/ },
  { key: 'mac-x64', re: /^AIDCP-(\d+\.\d+\.\d+)\.dmg$/ },
  { key: 'win-x64', re: /^AIDCP Setup (\d+\.\d+\.\d+)\.exe$/ },
];

/** 语义版本比较（a > b → 正数）。非法段按 0 处理，绝不抛。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 纯函数：给定目录下的文件名列表 → 清单。可脱离文件系统单测。
 * 严格按整名匹配，故 `AIDCP-0.2.4.dmg.bak-20260706-110723` 这类备份天然落选（不需要额外黑名单）。
 * 同平台多版本共存时取最高语义版本（真机上 downloads 目录里堆着历史包）。
 */
export function buildDownloadsManifest(fileNames: readonly string[]): DownloadsManifest {
  const best = new Map<DownloadItem['key'], DownloadItem>();
  for (const file of fileNames) {
    for (const { key, re } of PATTERNS) {
      const m = re.exec(file);
      if (!m) continue;
      const version = m[1];
      const prior = best.get(key);
      if (!prior || compareVersions(version, prior.version) > 0) {
        best.set(key, { key, label: PLATFORM_LABELS[key], file, version });
      }
      break;
    }
  }
  // 顺序固定（mac arm64 → mac x64 → win），与前端菜单期望一致。
  const items = (['mac-arm64', 'mac-x64', 'win-x64'] as const)
    .map((k) => best.get(k))
    .filter((v): v is DownloadItem => v !== undefined);
  // 展示用主版本：优先 mac（分发主力），否则取现有条目里的最高版本；一个都没有就是 null。
  const macVersion = best.get('mac-arm64')?.version ?? best.get('mac-x64')?.version ?? null;
  const version =
    macVersion
    ?? items.reduce<string | null>((hi, it) => (hi === null || compareVersions(it.version, hi) > 0 ? it.version : hi), null);
  return { version, items };
}

/** 该机 downloads 目录（部署约定；可经 env 覆盖，便于本地 / 异构部署）。 */
export function downloadsDir(): string {
  const v = process.env.AIDCP_DOWNLOADS_DIR;
  return v && v.trim() ? v.trim() : '/opt/aidcp/downloads';
}

/**
 * 读目录并产出清单。目录不存在 / 不可读 → 诚实空清单（不抛、不 500）：
 * 「这台机器上没有可下载的包」是一个合法且必须如实呈现的事实。
 */
export async function readDownloadsManifest(dir = downloadsDir()): Promise<DownloadsManifest> {
  try {
    const entries = await readdir(dir);
    return buildDownloadsManifest(entries);
  } catch {
    return { version: null, items: [] };
  }
}
