/**
 * 真实 `ali-oss` 客户端装配（change cloud-oss-storage-integration）。
 *
 * 这是**唯一** import `ali-oss` 的文件；由 server.ts 在启动期（凭据就绪时）调用。
 * OssObjectStore / relocate 的单测都不触达本文件，故恒可脱 ali-oss、脱网运行。
 *
 * 凭据明文只在此用于构造客户端；MUST NOT 日志化、MUST NOT 回前端。
 */

import OSS from 'ali-oss';
import { OssObjectStore } from './oss-object-store.js';

export interface OssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 桶名（如 aidcp）。 */
  bucket: string;
  /** region id（如 'oss-cn-beijing'）。用于签名与拼公网 URL。 */
  region: string;
  /**
   * 上传是否走内网 endpoint（ECS 与桶同区 cn-beijing 时置 true：免流量费 + 更快）。
   * 返回的稳定 URL 恒用公网 endpoint（OssObjectStore 内保证），故内外网只影响上传路径、不影响存/发的链接。
   */
  internal?: boolean;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** 用真实凭据构造 OSS 上传出口。凭据明文仅传入 ali-oss，绝不落日志。 */
export function createOssObjectStore(cfg: OssConfig): OssObjectStore {
  const client = new OSS({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    bucket: cfg.bucket,
    region: cfg.region,
    // V4 签名（官方推荐）。上传公读对象、返回稳定公网 URL，运行时无需再签名。
    authorizationV4: true,
    internal: cfg.internal ?? false,
    secure: true,
  });
  return new OssObjectStore({ client, bucket: cfg.bucket, region: cfg.region, logger: cfg.logger });
}
