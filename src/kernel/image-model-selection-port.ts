/**
 * 图片出口的模型选择（kernel）：全局「用哪个图片厂商、哪个图片模型」。
 *
 * **这条口与本批其余几条形状不同，原因写在这里，别照着别的抄。**
 * 读它的调用点是**同步**的，而且在热闭包里（每次配图取一次厂商、取一次模型）。
 * 把它改成 `await 一次 HTTP` 不是加个包装，是改掉每一个调用点的签名，并给热路径加一跳网络。
 * 所以跨进程形态是「**异步取源 + 同步读本地镜像**」两件事，而不是一个 HTTP 客户端：
 *   - {@link ImageModelSelectionSource} 是可跨进程的异步取数口（属主侧实现，能 HTTP 化）；
 *   - {@link ImageModelSelectionReader} 是调用点真正持有的同步口（本地镜像实现）。
 *
 * 单体里镜像就是配置存储自己的进程内缓存，两口指向同一份事实、逐字等价。
 *
 * **镜像的诚实要求**：从未成功取过数时 MUST 返回与配置存储同一套保守默认值，
 * MUST NOT 返回空串或猜测值 —— 图片厂商猜错的后果是整条配图链路静默走错供应商。
 */

export interface ImageModelSelection {
  /** 图片厂商标识（如 dashscope / volcengine）。 */
  imageProvider: string;
  /** 图片模型标识。 */
  imageModel: string;
}

/** 异步取源：属主侧实现，可跨进程。镜像刷新器调它。 */
export interface ImageModelSelectionSource {
  fetchImageModelSelection(): Promise<ImageModelSelection>;
}

/** 同步读：调用点持有的那一口。单体 = 配置存储的进程内缓存；拆进程 = 本地镜像。 */
export interface ImageModelSelectionReader {
  current(): ImageModelSelection;
}
