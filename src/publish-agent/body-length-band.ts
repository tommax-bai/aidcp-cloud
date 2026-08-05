import type { PlatformId } from '../kernel/platform-types.js';

/**
 * 正文长度的**确定性**闸（change fb-publish-fill-deadline 5.3b）。
 *
 * 在此之前，「全文 100-350 字」这类规则只活在 prompt 的一行文案里——纯软提示，模型给多少就是多少，
 * 云端一个字都不数。唯一在数字数的地方是 `content_too_long`（fill-budget 派生的硬上限），
 * 而那道闸**在发布指令下发前才响**：图已经生成、人已经审过，才发现这篇根本打不完。
 * 它是诚实闸、不是解法；真正该收的是生成侧。
 *
 * 三态而不是两态，理由是成本与后果都不对称：
 *  - `in_band`：合区间，直接采用。
 *  - `near_band`：越界但在容差内。**采用并记录**——超 5% 就重写一遍等于给几乎每一篇都多烧一次模型调用，
 *    而后果只是文章长了点、可恢复。按红线「概率低 × 后果可恢复 = 不加闸，记档即可」，这里只记档。
 *  - `out_of_tolerance`：离谱。**带纠正说明重写一次**（有界，只一次）。仍然离谱则采用较接近的那一稿并响亮记录，
 *    MUST NOT 中止整条管线——区间是质量目标不是物理约束，为它废掉一篇稿子是过度加闸。
 *
 * MUST NOT 截断正文来「满足」区间：截断出来的稿子是残句，比长稿糟得多，且会静默地把
 * 「模型没听话」伪装成「一切正常」。
 */
export interface BodyLengthBand {
  /** 区间下限（含）。 */
  min: number;
  /** 区间上限（含）。 */
  max: number;
}

/**
 * 各平台正文长度区间的**唯一事实源**。
 *
 * prompt 里那行「全文 X-Y 字」由 {@link describeBodyLengthBand} 从这里生成，校验器也读这里。
 * 两处各写一份数字的话，改了一处、另一处照旧——而症状是「规则明明写着却不生效」，
 * 没有任何东西会报错。
 *
 * `wechat_channels` 不在表内：视频号发布走的不是这条图文管线，没有实测过的区间，
 * **缺席即不设闸**，MUST NOT 借用别的平台的数字。
 */
export const BODY_LENGTH_BANDS: Partial<Record<PlatformId, BodyLengthBand>> = {
  facebook: { min: 100, max: 350 },
  xiaohongshu: { min: 200, max: 500 },
};

/** 容差比例：越界幅度在区间宽度的这个比例以内，视为 `near_band`。 */
export const BODY_LENGTH_TOLERANCE = 0.2;

export type BodyLengthVerdictKind = 'no_band' | 'in_band' | 'near_band' | 'out_of_tolerance';

export interface BodyLengthVerdict {
  kind: BodyLengthVerdictKind;
  /** 实测字数（码位，与边缘 `Array.from` 同口径）。 */
  length: number;
  band?: BodyLengthBand;
  /** 离区间最近边界的距离；合区间为 0。 */
  overshoot: number;
}

/**
 * 字数口径：**码位**（`Array.from`），与边缘逐字输入循环、与 fill-budget 的预算换算严格同口径。
 * 用 `String.length` 会把每个 emoji 数成 2，于是同一篇稿子在三个地方是三个长度。
 */
export function measureBodyLength(content: string): number {
  return Array.from(content.trim()).length;
}

export function bodyLengthBandFor(platform: PlatformId | undefined): BodyLengthBand | undefined {
  // platform 缺省即小红书（与 TriggerInput.platform 的既有语义一致，遗留调用方不带这个字段）。
  return BODY_LENGTH_BANDS[platform ?? 'xiaohongshu'];
}

/** 给 prompt 用的区间文案，例如 `100-350`。与校验器读同一张表。 */
export function describeBodyLengthBand(platform: PlatformId | undefined): string {
  const band = bodyLengthBandFor(platform);
  return band ? `${band.min}-${band.max}` : '';
}

export function judgeBodyLength(content: string, platform: PlatformId | undefined): BodyLengthVerdict {
  const length = measureBodyLength(content);
  const band = bodyLengthBandFor(platform);
  if (!band) return { kind: 'no_band', length, overshoot: 0 };
  const overshoot = length < band.min ? band.min - length : Math.max(0, length - band.max);
  if (overshoot === 0) return { kind: 'in_band', length, band, overshoot };
  const slack = Math.round((band.max - band.min) * BODY_LENGTH_TOLERANCE);
  return { kind: overshoot <= slack ? 'near_band' : 'out_of_tolerance', length, band, overshoot };
}

/**
 * 重写时追加给模型的纠正说明。
 *
 * 必须点名**实测多少字、要求多少字、往哪个方向改**：不带反馈的重试只是重掷一次骰子，
 * 期望值与第一稿相同，白烧一次调用。
 */
export function bodyLengthCorrection(verdict: BodyLengthVerdict): string {
  if (!verdict.band) return '';
  const direction = verdict.length < verdict.band.min ? '偏短，请展开补充具体细节' : '偏长，请压缩删减';
  return [
    '',
    '【重写要求】',
    `上一稿正文实测 ${verdict.length} 字，${direction}，务必落在 ${verdict.band.min}-${verdict.band.max} 字。`,
    '这是硬性要求：只调整正文篇幅与详略，主题、事实与语气保持不变，不要改写成另一篇。',
  ].join('\n');
}
