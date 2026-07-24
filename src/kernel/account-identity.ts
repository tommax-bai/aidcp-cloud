/**
 * 退役保留账号哨兵 id（原定义在 src/account-store.ts，api）。抬入 kernel（change decouple-longtail-sweep）
 * 供发布媒体存储等跨边界消费方直接比对，无需 type/value 依赖 api 侧账号主数据存储。
 * 纯字符串常量：零 import、零 SQL、零活状态，满足 §4.7 kernel 准入。
 */
export const RETIRED_ACCOUNT_ID = 'default';
