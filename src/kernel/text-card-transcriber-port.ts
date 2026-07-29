/**
 * 图内文字卡转写口（kernel）：**只有形状，没有实现**。
 *
 * 为什么在 kernel：转写器**本体留 content**（它要视觉模型客户端、形态感知器、OSS 图址——全是 content 的东西），
 * 但调用它的是 automation 的精选准入评估角色。两侧都要认识这三个接口，谁 import 谁都是一条跨属主边，
 * 所以下沉到共享层；**MUST NOT 在此提供任何默认实现或兜底转写**——拿不到实现时的处置由调用方按
 * 「诚实记录并跳过」办（见 {@link TextCardTranscriberCapability}）。
 *
 * 与 `curated-content-types.ts` 的分工：那边是精选内容的**数据模型**，这边是**调用口**；
 * 两个文件都只放类型（本文件的运行时结算函数在 `text-card-transcription.ts`，
 * 与既有「纯类型文件不塞运行时函数」的约定同向）。
 */
import type {
  CuratedReferenceImage,
  CuratedReferenceImageInput,
  CuratedTextCardContext,
  TextCardTranscription,
} from './curated-content-types.js';

export interface TextCardTranscriberInput {
  accountId: string;
  sourceId: string;
  images: CuratedReferenceImageInput[];
  snapshotAt: number;
  cached?: CuratedTextCardContext | null;
}

export interface TextCardTranscriberOutcome {
  images: CuratedReferenceImage[];
  transcription?: TextCardTranscription;
  cacheHit: boolean;
}

export interface TextCardTranscriber {
  /** 运营旗标：能力接上了但当前不转写。**与「依赖没接上」是两件事**，别把后者压成它。 */
  enabled(): boolean;
  transcribe(input: TextCardTranscriberInput): Promise<TextCardTranscriberOutcome>;
}

/**
 * 转写能力的**构造期**二态。运行时再叠一层旗标，合起来是 {@link TextCardTranscriptionMode} 的三态。
 *
 * 这条 union 存在的全部理由：`transcriber?.enabled()` 在依赖缺席时整个表达式是 `undefined`、判定为假，
 * 于是「旗标关掉了」与「依赖没接上」在代码里长得一模一样——后者是装配缺陷，被压成前者就是静默假成功。
 * 组合根 MUST 显式给出这两态之一，`unavailable` 必须带上可读 reason（它会被打进日志）。
 */
export type TextCardTranscriberCapability =
  | { state: 'wired'; transcriber: TextCardTranscriber }
  | { state: 'unavailable'; reason: string };

/**
 * 调用点真正要分的三态：
 * - `active`：能力在、旗标开 → 正常转写；
 * - `flag_off`：能力在、旗标关 → 运营选择，静默跳过是对的；
 * - `unavailable`：能力压根没接上 → **必须留痕**，且 MUST NOT 抛（这条角色是 fire-and-forget，
 *   抛出会打断浏览主路径）。
 */
export type TextCardTranscriptionMode = 'active' | 'flag_off' | 'unavailable';
