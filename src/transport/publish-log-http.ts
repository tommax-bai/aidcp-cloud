/**
 * 发布台账窄写入口的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **api** 进程（`publish_log` 在它的库里），客户端跑在 **content** 进程。
 *
 * **这条口与只读那几条不同：它是写，所以失败 MUST 原样抛给调用方。**
 * 候审卡投递判定那条可以 fail-open（多发一张卡无害）；台账写不行——
 * 「以为落库了其实没落」正是本仓红线点名的静默假成功：稿子会以为自己已候审，
 * 而后续任何按 id 定位的动作都找不到那一行。写失败就要让发布出口角色当场看见。
 *
 * 端口上四个方法**全是必选**：跨进程这一侧不存在「这个方法碰巧没实现」的形态——
 * 对端要么有、要么整条 route 报错，绝不能表现成「悄悄没做」。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { PublishLogWriter } from '../kernel/publish-log-writer-port.js';
import type { PublishRecord, PublishStatus } from '../kernel/publish-pipeline-types.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PUBLISH_LOG_ROUTES = {
  insert: 'publish-log/insert',
  updateStatus: 'publish-log/update-status',
  recordMetadata: 'publish-log/record-metadata',
  markImagesAttached: 'publish-log/mark-images-attached',
} as const;

/** 把一个本地台账写入口注册为内部 HTTP route。只做参数解包 → 转调 → 回传，零业务逻辑。 */
export function registerPublishLogRoutes(server: InternalHttpServer, local: PublishLogWriter): void {
  server.register(PUBLISH_LOG_ROUTES.insert, (args) => {
    const a = args as { record: PublishRecord };
    return local.insert(a.record);
  });
  server.register(PUBLISH_LOG_ROUTES.updateStatus, async (args) => {
    const a = args as { id: number; status: PublishStatus };
    await local.updateStatus(a.id, a.status);
    return null;
  });
  server.register(PUBLISH_LOG_ROUTES.recordMetadata, async (args) => {
    const a = args as { id: number; metadata: unknown; aiEnforced: boolean };
    await local.recordMetadata(a.id, a.metadata, a.aiEnforced);
    return null;
  });
  server.register(PUBLISH_LOG_ROUTES.markImagesAttached, async (args) => {
    const a = args as { id: number; count: number };
    await local.markImagesAttached(a.id, a.count);
    return null;
  });
}

/** `PublishLogWriter` 的 HTTP 实现：每个方法一次调用，失败原样抛。 */
export class PublishLogHttpClient implements PublishLogWriter {
  constructor(private readonly http: InternalHttpClient) {}

  insert(record: PublishRecord): Promise<number> {
    return this.http.call<number>(PUBLISH_LOG_ROUTES.insert, { record });
  }

  async updateStatus(id: number, status: PublishStatus): Promise<void> {
    await this.http.call(PUBLISH_LOG_ROUTES.updateStatus, { id, status });
  }

  async recordMetadata(id: number, metadata: unknown, aiEnforced: boolean): Promise<void> {
    await this.http.call(PUBLISH_LOG_ROUTES.recordMetadata, { id, metadata, aiEnforced });
  }

  async markImagesAttached(id: number, count: number): Promise<void> {
    await this.http.call(PUBLISH_LOG_ROUTES.markImagesAttached, { id, count });
  }
}
