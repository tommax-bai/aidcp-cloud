const DAY_MS = 24 * 60 * 60_000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60_000;

export const SHANGHAI_DAY_START_SQL =
  "(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')";

export function shanghaiDayStartMs(at: number): number {
  return Math.floor((at + SHANGHAI_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_UTC_OFFSET_MS;
}

export function nextShanghaiDayStartMs(at: number): number {
  return shanghaiDayStartMs(at) + DAY_MS;
}
