/**
 * 全局模型配置的**值形状与缺省默认**（change cloud-batch2-content-main · 批次 2 content main()）。
 *
 * 这两样东西原本长在 api 属主的模型配置存储里。析出到 kernel 的直接理由是**拆进程后出现了第二个读者**：
 * 内容进程的两个本地镜像（图片模型选择 / 角色模型解析）都要一份「从未取到过时用的保守默认」，
 * 而它们跑在另一个仓、另一个进程里，够不着那个存储。
 *
 * 若两边各写一份字面量，会得到本仓反复点名的那种漂移：**两侧各自编译通过、各自测试通过**，
 * 只有在属主侧改了默认模型名、而内容侧那份没跟上时才会现形 —— 现形的方式还不是报错，
 * 是「取不到配置的那一小段时间里，配图悄悄用了另一个（可能已下架的）模型」。
 * 一份定义、两边共用，是唯一能机械保证同源的形态。
 *
 * 析出的只有**纯值**：类型 + 常量，零 import、零 SQL / HTTP / 副作用。
 * 建表 SQL、缓存、镜像版本推送等仍留在属主存储里（那才是它的业务）。
 */

export interface ModelConfigValue {
  textModel: string;
  /** 全局文本厂商（change model-config-volcengine-provider）；缺/空回落 dashscope。 */
  textProvider: string;
  imageModel: string;
  /**
   * 全局图片厂商（change image-provider-volcengine-seedream）；缺/空回落 dashscope（万相）。
   * dashscope→通义万相（异步）、volcengine→即梦 Seedream（火山方舟 Ark 同步）。独立于 textProvider。
   */
  imageProvider: string;
}

/**
 * 缺行 / PG 不可用 / 跨进程取源从未成功时的回退默认。
 *
 * textModel 必须指向**现役在售**模型：qwen-turbo 百炼 2026-07-13 下架，兜底指向已下架模型 = 兜底即坏
 * （change llm-role-review-remediation）。qwen.ts 构造默认仍为 qwen-turbo，仅存于无解析器注入的单测路径。
 * imageModel 与 wanxiang-client.ts 构造默认一致。
 */
export const MODEL_CONFIG_DEFAULTS: ModelConfigValue = {
  textModel: 'qwen3.7-plus',
  // 全局文本厂商默认 dashscope（零回归基准）。change model-config-volcengine-provider。
  textProvider: 'dashscope',
  imageModel: 'wan2.7-image-pro',
  // 全局图片厂商默认 dashscope（万相；零回归基准）。change image-provider-volcengine-seedream。
  imageProvider: 'dashscope',
};
