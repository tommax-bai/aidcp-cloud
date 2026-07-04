/**
 * 通用对象存储上传出口（change cloud-oss-storage-integration）。
 *
 * 目标：给系统一个**可复用**的「字节 + 对象键 → 稳定公网 URL」接口，供未来任意
 * 「上传图片/文件」场景复用，首个消费者是发帖生成的配图转存。
 *
 * 设计红线：
 * - 接口与具体实现（阿里云 OSS）解耦 → 调用方只依赖 `ObjectStore`，可注入内存假实现脱网单测。
 * - MUST NOT 绑死「配图」单一用途；键布局由调用方决定，本接口只负责上传 + 返回稳定 URL。
 *
 * 本文件只含**纯逻辑**（接口 + 转存助手 + 字节类型嗅探），不 import `ali-oss`，
 * 故引用它的测试恒可脱网运行（OSS 具体实现见 oss-object-store.ts / oss-client-factory.ts）。
 */

export interface PutOptions {
  /** 对象内容类型（如 image/png）；缺省由 OSS 侧按默认处理。 */
  contentType?: string;
}

export interface PutResult {
  /** 上传成功后可匿名访问的稳定公网 URL。 */
  url: string;
}

/** 可注入的对象上传出口：字节 + 键 → 稳定公网 URL。 */
export interface ObjectStore {
  put(key: string, bytes: Buffer, opts?: PutOptions): Promise<PutResult>;
}

/** 字节类型嗅探结果。 */
export interface SniffedType {
  /** 文件扩展名（不含点，如 'png'）。 */
  ext: string;
  /** 内容类型（如 'image/png'）。 */
  contentType: string;
}

/**
 * 从字节 magic-byte 判 jpg/png/webp/gif；判不出时回退响应头 content-type（仅当其为 image/*）；
 * 再判不出兜底 jpg（provider 返回的确是图片字节，宁可给个安全默认也不因类型未知而丢图）。
 */
export function sniffImageType(bytes: Uint8Array, headerContentType?: string | null): SniffedType {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' };
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  // GIF: 'GIF8'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  // magic 判不出：仅接受 image/* 的响应头，映射到已知扩展名。
  const header = headerContentType?.trim().toLowerCase() ?? '';
  if (header.startsWith('image/')) {
    const sub = header.slice('image/'.length).split(';')[0].trim();
    if (sub === 'jpeg' || sub === 'jpg') return { ext: 'jpg', contentType: 'image/jpeg' };
    if (sub === 'png') return { ext: 'png', contentType: 'image/png' };
    if (sub === 'webp') return { ext: 'webp', contentType: 'image/webp' };
    if (sub === 'gif') return { ext: 'gif', contentType: 'image/gif' };
  }
  // 兜底：按 jpg 处理（安全默认，不因类型未知而丢真实图片字节）。
  return { ext: 'jpg', contentType: 'image/jpeg' };
}

export interface RelocateDeps {
  store: ObjectStore;
  /** 抓源字节用的 fetch（缺省全局 fetch，测试可注入假实现脱网）。 */
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 抓字节 + 上传的总超时（毫秒），缺省 30s。 */
  timeoutMs?: number;
}

/**
 * 把一个可 fetch 的源 URL（如 provider 临时图链）的字节转存到对象存储，返回稳定公网 URL。
 *
 * 红线：抓字节或上传任一失败 → 返回 `null`（诚实落空，**绝不伪造/占位 URL、绝不假成功**）；
 * 调用方据此把该项诚实丢弃（如配图「M 少一张」语义）。
 *
 * @param sourceUrl 源 URL（可匿名 fetch）
 * @param keyBase   对象键**不含扩展名**的前缀（如 'publish/<acct>/<run>/0'）；扩展名按嗅探结果追加
 */
export async function relocateImageToStore(
  sourceUrl: string,
  keyBase: string,
  deps: RelocateDeps,
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger ?? console;
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : 30_000;
  if (!fetchImpl) {
    logger.warn('[relocate] 全局 fetch 不可用且未注入 fetchImpl，转存诚实落空');
    return null;
  }
  // 超时 MUST 覆盖「抓字节 + 上传」两段（不止 fetch）：一段 timer 到点即 abort fetch + 令整段 race 落空。
  // 上传若已在飞行（fetch 已完成），abort 管不到它——但 race 已解出 null、调用方按诚实落空推进，
  // 后台那次 put 由底层客户端自身超时兜底收尾（work 内已吞错，不产生未处理拒绝）。
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      logger.warn(`[relocate] 转存超时 ${timeoutMs}ms（抓字节+上传，诚实落空）`);
      resolve(null);
    }, timeoutMs);
  });
  // work 自吞全部异常 → 恒 resolve string|null，绝不 reject（故 race 不会因落败分支未处理而抛未处理拒绝）。
  const work = (async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(sourceUrl, { signal: controller.signal });
      if (!res.ok) {
        logger.warn(`[relocate] 抓源图失败 HTTP ${res.status}（诚实落空，不伪造 URL）`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        logger.warn('[relocate] 源图字节为空（诚实落空）');
        return null;
      }
      const { ext, contentType } = sniffImageType(buf, res.headers.get('content-type'));
      const { url } = await deps.store.put(`${keyBase}.${ext}`, buf, { contentType });
      return url;
    } catch (err) {
      logger.warn(`[relocate] 转存异常: ${err instanceof Error ? err.message : String(err)}（诚实落空）`);
      return null;
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
