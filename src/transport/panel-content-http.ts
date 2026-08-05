/**
 * 管理后台读写内容域属主表的三族跨进程窄口（change restore-panel-capability-wiring）。
 *
 * 面板住在接口进程，这三族的事实源全在内容进程：
 *   - **用量成本**：token 用量台账 + 账单价刷新（后台「用量成本」页）
 *   - **精选库**：列表 / 筛选面 / 删单条 / 清空壳行 / 读单行（后台「精选库」页）
 *   - **FB 发帖素材**：列表 / 上传 / 重排 / 改组 / 删组（后台 FB 发帖的图片区）
 *
 * 三条纪律：
 *
 * ① **账号隔离由属主侧保证**。精选库的每个读写都把 `account_id` 放进 WHERE 防越权；
 *    跨进程之后这条 MUST 仍由属主侧的同一段 SQL 保证，MUST NOT 变成「调用方记得传对
 *    accountId 就行」——那是把一条强制约束降级成一个约定。
 *
 * ② **删组是软删**（`status:'deleted'`），与单体逐字同源。写成硬删会让「已发出的素材
 *    还能不能追溯」这件事悄悄改变语义。
 *
 * ③ **上传是大载荷**：单张原图上限 10 MiB，Base64 编码后约 14 MiB，超过内部 HTTP 的
 *    默认 8 MiB 上限。属主侧的服务器上限与调用侧的超时都 MUST 显式放宽（见
 *    `PANEL_CONTENT_MEDIA_UPLOAD_*` 两个常量），否则表现是一次看不出原因的失败：
 *    运营只会看到「上传失败」，而真实原因是请求体在传输层就被砍了。
 */
import type {
  CuratedContentTypeFilter,
  CuratedFacets,
  CuratedPanelListResult,
  CuratedPanelRow,
} from '../kernel/curated-content-types.js';
import type { LlmUsagePayload, LlmUsageQuery } from '../kernel/llm-usage-types.js';
import type { BillingPriceRefreshResult } from '../kernel/billing-price-refresh-types.js';
import type {
  FacebookPublishImageInput,
  FacebookPublishImageSetView,
  FacebookPublishMediaListView,
  FacebookPublishSetPatch,
  FacebookPublishUploadResult,
} from '../kernel/facebook-publish-media-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const PANEL_CONTENT_ROUTES = {
  usage: 'panel-content/llm-usage',
  billingPriceRefresh: 'panel-content/billing-price-refresh',
  curatedList: 'panel-content/curated/list',
  curatedFacets: 'panel-content/curated/facets',
  curatedDeleteOne: 'panel-content/curated/delete-one',
  curatedClearEmptyBody: 'panel-content/curated/clear-empty-body',
  curatedGetOne: 'panel-content/curated/get-one',
  mediaList: 'panel-content/fb-media/list',
  mediaUpload: 'panel-content/fb-media/upload',
  mediaReorder: 'panel-content/fb-media/reorder',
  mediaUpdateSet: 'panel-content/fb-media/update-set',
  mediaDeleteSet: 'panel-content/fb-media/delete-set',
} as const;

/**
 * 属主侧内部 HTTP 服务端的请求体上限：要容得下一次 FB 素材上传。
 * 单张原图 10 MiB → Base64 约 14 MiB，多张一次提交还要更多；24 MiB 留出余量。
 * 这个值只影响 localhost 上的进程间通道（对外那一跳由 Nginx 另行限）。
 */
export const PANEL_CONTENT_MEDIA_UPLOAD_MAX_BODY_BYTES = 24 * 1024 * 1024;

/**
 * 调用侧上传专用连接的超时：大载荷传输 + 属主侧逐张落库/转存，默认 15s 必然不够。
 * 用一条单独放宽的连接，其余路由仍走默认那条——放宽全部只会让一次真故障拖更久才现形。
 */
export const PANEL_CONTENT_MEDIA_UPLOAD_TIMEOUT_MS = 120_000;

/** 面板要的精选库读写面（形状与 `PanelDeps.curatedContent` 同源，结构对接）。 */
export interface PanelCuratedContentPort {
  listForPanel(
    accountId: string | undefined,
    opts: {
      contentType?: CuratedContentTypeFilter;
      admitReason?: string;
      limit: number;
      offset: number;
    },
  ): Promise<CuratedPanelListResult>;
  facetsForPanel(accountId?: string): Promise<CuratedFacets>;
  deleteOne(accountId: string, id: number): Promise<number>;
  clearEmptyBody(accountId: string): Promise<number>;
  getOneForAccount(id: number, accountId: string): Promise<CuratedPanelRow | null>;
}

/** 面板要的 FB 素材读写面（形状与 `PanelDeps.facebookPublishMedia` 同源）。 */
export interface PanelFacebookMediaPort {
  list(accountId: string): Promise<FacebookPublishMediaListView>;
  upload(
    accountId: string,
    files: FacebookPublishImageInput[],
  ): Promise<{ results: FacebookPublishUploadResult[]; view: FacebookPublishMediaListView }>;
  reorder(accountId: string, orderedSetIds: number[]): Promise<FacebookPublishMediaListView>;
  updateSet(
    accountId: string,
    setId: number,
    patch: FacebookPublishSetPatch,
  ): Promise<FacebookPublishImageSetView | null>;
  deleteSet(accountId: string, setId: number): Promise<FacebookPublishImageSetView | null>;
}

export interface PanelContentOwnerPorts {
  usage: { usage(query: LlmUsageQuery): Promise<LlmUsagePayload> };
  billingPriceRefresh: { refresh(): Promise<BillingPriceRefreshResult> };
  curated?: PanelCuratedContentPort;
  media?: PanelFacebookMediaPort;
}

/**
 * 属主侧注册。`curated` / `media` 缺实例时**不注册**对应路由，绝不注册一条
 * 「属主不在就静默成功」的空路由——那会把「精选库暂时不可用」画成「一条都没有」。
 * 调用方拿到的是跨进程 404，与业务上的「没有数据」在类型上就不同。
 */
export function registerPanelContentRoutes(
  server: InternalHttpServer,
  local: PanelContentOwnerPorts,
): void {
  server.register(PANEL_CONTENT_ROUTES.usage, (args) =>
    local.usage.usage((args as { query: LlmUsageQuery }).query),
  );
  server.register(PANEL_CONTENT_ROUTES.billingPriceRefresh, () =>
    local.billingPriceRefresh.refresh(),
  );

  const curated = local.curated;
  if (curated) {
    server.register(PANEL_CONTENT_ROUTES.curatedList, (args) => {
      const a = args as {
        accountId?: string;
        opts: {
          contentType?: CuratedContentTypeFilter;
          admitReason?: string;
          limit: number;
          offset: number;
        };
      };
      return curated.listForPanel(a.accountId, a.opts);
    });
    server.register(PANEL_CONTENT_ROUTES.curatedFacets, (args) =>
      curated.facetsForPanel((args as { accountId?: string }).accountId),
    );
    server.register(PANEL_CONTENT_ROUTES.curatedDeleteOne, (args) => {
      const a = args as { accountId: string; id: number };
      return curated.deleteOne(a.accountId, a.id);
    });
    server.register(PANEL_CONTENT_ROUTES.curatedClearEmptyBody, (args) =>
      curated.clearEmptyBody((args as { accountId: string }).accountId),
    );
    server.register(PANEL_CONTENT_ROUTES.curatedGetOne, (args) => {
      const a = args as { id: number; accountId: string };
      return curated.getOneForAccount(a.id, a.accountId);
    });
  }

  const media = local.media;
  if (media) {
    server.register(PANEL_CONTENT_ROUTES.mediaList, (args) =>
      media.list((args as { accountId: string }).accountId),
    );
    server.register(PANEL_CONTENT_ROUTES.mediaUpload, (args) => {
      const a = args as { accountId: string; files: FacebookPublishImageInput[] };
      return media.upload(a.accountId, a.files);
    });
    server.register(PANEL_CONTENT_ROUTES.mediaReorder, (args) => {
      const a = args as { accountId: string; orderedSetIds: number[] };
      return media.reorder(a.accountId, a.orderedSetIds);
    });
    server.register(PANEL_CONTENT_ROUTES.mediaUpdateSet, (args) => {
      const a = args as { accountId: string; setId: number; patch: FacebookPublishSetPatch };
      return media.updateSet(a.accountId, a.setId, a.patch);
    });
    server.register(PANEL_CONTENT_ROUTES.mediaDeleteSet, (args) => {
      const a = args as { accountId: string; setId: number };
      // 软删，与单体逐字同源：删组 = 把该组标成 deleted，不是把行抹掉。
      return media.updateSet(a.accountId, a.setId, { status: 'deleted' });
    });
  }
}

export class PanelTokenUsageHttpClient {
  constructor(private readonly http: InternalHttpClient) {}

  usage(query: LlmUsageQuery): Promise<LlmUsagePayload> {
    return this.http.call<LlmUsagePayload>(PANEL_CONTENT_ROUTES.usage, { query });
  }
}

export class PanelBillingPriceRefreshHttpClient {
  constructor(private readonly http: InternalHttpClient) {}

  refresh(): Promise<BillingPriceRefreshResult> {
    return this.http.call<BillingPriceRefreshResult>(PANEL_CONTENT_ROUTES.billingPriceRefresh, {});
  }
}

export class PanelCuratedContentHttpClient implements PanelCuratedContentPort {
  constructor(private readonly http: InternalHttpClient) {}

  listForPanel(
    accountId: string | undefined,
    opts: {
      contentType?: CuratedContentTypeFilter;
      admitReason?: string;
      limit: number;
      offset: number;
    },
  ): Promise<CuratedPanelListResult> {
    return this.http.call<CuratedPanelListResult>(PANEL_CONTENT_ROUTES.curatedList, {
      accountId,
      opts,
    });
  }

  facetsForPanel(accountId?: string): Promise<CuratedFacets> {
    return this.http.call<CuratedFacets>(PANEL_CONTENT_ROUTES.curatedFacets, { accountId });
  }

  deleteOne(accountId: string, id: number): Promise<number> {
    return this.http.call<number>(PANEL_CONTENT_ROUTES.curatedDeleteOne, { accountId, id });
  }

  clearEmptyBody(accountId: string): Promise<number> {
    return this.http.call<number>(PANEL_CONTENT_ROUTES.curatedClearEmptyBody, { accountId });
  }

  getOneForAccount(id: number, accountId: string): Promise<CuratedPanelRow | null> {
    return this.http.call<CuratedPanelRow | null>(PANEL_CONTENT_ROUTES.curatedGetOne, {
      id,
      accountId,
    });
  }
}

export class PanelFacebookMediaHttpClient implements PanelFacebookMediaPort {
  /**
   * `http` 走默认连接；`uploadHttp` 是**放宽了超时**的那条，只给上传用。
   * 不传 `uploadHttp` 时上传也走默认连接——那在大图上会超时，所以组装根 MUST 传。
   */
  constructor(
    private readonly http: InternalHttpClient,
    private readonly uploadHttp: InternalHttpClient = http,
  ) {}

  list(accountId: string): Promise<FacebookPublishMediaListView> {
    return this.http.call<FacebookPublishMediaListView>(PANEL_CONTENT_ROUTES.mediaList, {
      accountId,
    });
  }

  upload(
    accountId: string,
    files: FacebookPublishImageInput[],
  ): Promise<{ results: FacebookPublishUploadResult[]; view: FacebookPublishMediaListView }> {
    return this.uploadHttp.call<{
      results: FacebookPublishUploadResult[];
      view: FacebookPublishMediaListView;
    }>(PANEL_CONTENT_ROUTES.mediaUpload, { accountId, files });
  }

  reorder(accountId: string, orderedSetIds: number[]): Promise<FacebookPublishMediaListView> {
    return this.http.call<FacebookPublishMediaListView>(PANEL_CONTENT_ROUTES.mediaReorder, {
      accountId,
      orderedSetIds,
    });
  }

  updateSet(
    accountId: string,
    setId: number,
    patch: FacebookPublishSetPatch,
  ): Promise<FacebookPublishImageSetView | null> {
    return this.http.call<FacebookPublishImageSetView | null>(
      PANEL_CONTENT_ROUTES.mediaUpdateSet,
      { accountId, setId, patch },
    );
  }

  deleteSet(accountId: string, setId: number): Promise<FacebookPublishImageSetView | null> {
    return this.http.call<FacebookPublishImageSetView | null>(
      PANEL_CONTENT_ROUTES.mediaDeleteSet,
      { accountId, setId },
    );
  }
}
