/**
 * 角色模型解析的跨进程三件套 **+ 本地镜像**。形状与 {@link file://./image-model-selection-http.ts} 同，
 * 理由也同：调用点是同步的、在每次模型调用的路径上。
 *
 * 镜像的三条纪律与图片那条完全一致：从未取到过回保守默认、刷新失败保留上一份好值并留 warn、
 * 定时器 unref。**未登记角色查不到就用 fallback**，这不是降级、是这条口的正常语义
 * （单体里那种角色本来就穿过前两层落到全局）。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  RoleModelSelection,
  RoleModelSelectionReader,
  RoleModelSelectionSnapshot,
  RoleModelSelectionSource,
} from '../kernel/role-model-selection-port.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const ROLE_MODEL_SELECTION_ROUTES = {
  fetch: 'role-model-selection/fetch',
} as const;

/** 把一个本地取源实现注册为内部 HTTP route。 */
export function registerRoleModelSelectionRoutes(
  server: InternalHttpServer,
  local: RoleModelSelectionSource,
): void {
  server.register(ROLE_MODEL_SELECTION_ROUTES.fetch, () => local.fetchRoleModelSelections());
}

/** 异步取源口的 HTTP 实现。失败原样抛——由镜像决定怎么降级。 */
export class RoleModelSelectionHttpClient implements RoleModelSelectionSource {
  constructor(private readonly http: InternalHttpClient) {}

  fetchRoleModelSelections(): Promise<RoleModelSelectionSnapshot> {
    return this.http.call<RoleModelSelectionSnapshot>(ROLE_MODEL_SELECTION_ROUTES.fetch, {});
  }
}

export interface PollingRoleModelSelectionMirrorOptions {
  source: RoleModelSelectionSource;
  /** 从未取到过时用的保守默认。MUST 与属主侧配置存储的默认同源。 */
  fallback: RoleModelSelection;
  /** 刷新周期，默认 60s。 */
  intervalMs?: number;
  logger?: Pick<Console, 'warn'>;
}

/** 有界轮询的本地镜像：满足调用点要的同步读口。 */
export class PollingRoleModelSelectionMirror implements RoleModelSelectionReader {
  private snapshot: RoleModelSelectionSnapshot;
  private everLoaded = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: PollingRoleModelSelectionMirrorOptions) {
    this.snapshot = { fallback: options.fallback, byRole: {} };
  }

  /** 同步读。未登记角色 / 不带角色 → fallback（**正常语义，不是降级**）。 */
  forRole(role?: string): RoleModelSelection {
    if (!role) return this.snapshot.fallback;
    return this.snapshot.byRole[role] ?? this.snapshot.fallback;
  }

  loaded(): boolean {
    return this.everLoaded;
  }

  async refreshOnce(): Promise<void> {
    try {
      this.snapshot = await this.options.source.fetchRoleModelSelections();
      this.everLoaded = true;
    } catch (error) {
      (this.options.logger ?? console).warn(
        `[role-model-mirror] 刷新失败，沿用${this.everLoaded ? '上一份' : '保守默认'}：${(error as Error).message}`,
      );
    }
  }

  async start(): Promise<void> {
    await this.refreshOnce();
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshOnce(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
