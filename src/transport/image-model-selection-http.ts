/**
 * 图片模型选择的跨进程三件套 **+ 一个本地镜像**。
 *
 * 别的三件套只有「服务端注册 + 客户端 + 路径常量」；这条多一个 {@link PollingImageModelSelectionMirror}，
 * 因为调用点要的是**同步**读（见 kernel 端口文档）。HTTP 客户端满足的是异步取源口，
 * 镜像才是调用点真正持有的那一口。
 *
 * 镜像的三条纪律：
 *   ① **从未取到过时返回保守默认**，而不是空串——图片厂商猜错会让整条配图链路静默走错供应商；
 *   ② 刷新失败**保留上一份好值**并留一行 warn，不清空（陈旧一会儿远好过突然全体回落默认）；
 *   ③ 定时器 `unref`，绝不因为一个配置镜像而挡住进程退出。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  ImageModelSelection,
  ImageModelSelectionReader,
  ImageModelSelectionSource,
} from '../kernel/image-model-selection-port.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const IMAGE_MODEL_SELECTION_ROUTES = {
  fetch: 'image-model-selection/fetch',
} as const;

/** 把一个本地取源实现注册为内部 HTTP route。 */
export function registerImageModelSelectionRoutes(
  server: InternalHttpServer,
  local: ImageModelSelectionSource,
): void {
  server.register(IMAGE_MODEL_SELECTION_ROUTES.fetch, () => local.fetchImageModelSelection());
}

/** 异步取源口的 HTTP 实现。失败原样抛——由镜像决定怎么降级，传输层不替它做主。 */
export class ImageModelSelectionHttpClient implements ImageModelSelectionSource {
  constructor(private readonly http: InternalHttpClient) {}

  fetchImageModelSelection(): Promise<ImageModelSelection> {
    return this.http.call<ImageModelSelection>(IMAGE_MODEL_SELECTION_ROUTES.fetch, {});
  }
}

export interface PollingImageModelSelectionMirrorOptions {
  source: ImageModelSelectionSource;
  /** 从未取到过时用的保守默认。MUST 与属主侧配置存储的默认同源。 */
  fallback: ImageModelSelection;
  /** 刷新周期，默认 60s。 */
  intervalMs?: number;
  logger?: Pick<Console, 'warn'>;
}

/**
 * 有界轮询的本地镜像：满足调用点要的同步读口。
 *
 * 形态照抄本仓既有的配置镜像（有界轮询 + 只在拿到好值时替换），**没有**引入任何新机制。
 */
export class PollingImageModelSelectionMirror implements ImageModelSelectionReader {
  private value: ImageModelSelection;
  private everLoaded = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: PollingImageModelSelectionMirrorOptions) {
    this.value = options.fallback;
  }

  /** 同步读。从未取到过 → 保守默认（绝不空串、绝不猜）。 */
  current(): ImageModelSelection {
    return this.value;
  }

  /** 是否已经至少成功取到过一次（供启动自证 / 可观测性，绝不用它替代 current 的降级语义）。 */
  loaded(): boolean {
    return this.everLoaded;
  }

  async refreshOnce(): Promise<void> {
    try {
      const next = await this.options.source.fetchImageModelSelection();
      this.value = next;
      this.everLoaded = true;
    } catch (error) {
      // 保留上一份好值：陈旧一会儿远好过突然全体回落默认。
      (this.options.logger ?? console).warn(
        `[image-model-mirror] 刷新失败，沿用${this.everLoaded ? '上一份' : '保守默认'}：${(error as Error).message}`,
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
