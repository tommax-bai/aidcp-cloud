/**
 * 阿里云 OSS 版对象上传出口（change cloud-oss-storage-integration）。
 *
 * 只依赖一个**窄接口** `OssPutClient`（仅 `put`），不 import `ali-oss` —— 真实 `ali-oss` 客户端
 * 由 oss-client-factory.ts 构造并注入，故本文件与其单测恒可脱 `ali-oss`、脱网运行。
 *
 * 红线：
 * - 上传对象设公读 ACL（配图本就要公开发到小红书，用户已确认走公读永久链接）。
 * - 返回的稳定 URL 恒用**公网 endpoint**（即便上传走内网 endpoint），根治「审批超 provider TTL → 死链」。
 * - `put` 失败时向上抛（由调用方 relocate 捕获 → 诚实落空），MUST NOT 在此吞错假成功。
 */

import type { ObjectStore, PutOptions, PutResult } from './object-store.js';

/** `ali-oss` 客户端的窄接口（仅本模块用到的 put）；便于注入假实现单测。 */
export interface OssPutClient {
  put(
    name: string,
    file: Buffer,
    options?: { headers?: Record<string, string>; mime?: string },
  ): Promise<{ name: string; url?: string; res?: { status?: number } }>;
}

export interface OssObjectStoreOptions {
  /** 已构造好的 OSS 客户端（真实 ali-oss 或测试假实现）。 */
  client: OssPutClient;
  /** 桶名（如 aidcp）。 */
  bucket: string;
  /** 公网 region host 段（如 'oss-cn-beijing'），用于拼稳定公网 URL。 */
  region: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class OssObjectStore implements ObjectStore {
  private readonly client: OssPutClient;
  private readonly publicBase: string;

  constructor(opts: OssObjectStoreOptions) {
    this.client = opts.client;
    // 稳定公网 URL 恒用公网 endpoint（去掉可能的 -internal 后缀），即便上传走内网也如此。
    const publicRegion = opts.region.replace(/-internal$/, '');
    this.publicBase = `https://${opts.bucket}.${publicRegion}.aliyuncs.com`;
  }

  async put(key: string, bytes: Buffer, opts?: PutOptions): Promise<PutResult> {
    const headers: Record<string, string> = { 'x-oss-object-acl': 'public-read' };
    if (opts?.contentType) headers['Content-Type'] = opts.contentType;
    // ali-oss put 失败会抛；不在此捕获——让 relocate 层据此诚实落空，绝不假成功。
    await this.client.put(key, bytes, { headers });
    return { url: `${this.publicBase}/${key}` };
  }
}
