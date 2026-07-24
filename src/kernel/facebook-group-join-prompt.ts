/**
 * Facebook 群组加入判定的**纯 prompt 构建段**（change decouple-behavior-class-ports 析出）。
 *
 * 从 src/agents/facebook-group-join-judge.ts（automation）抬出：观测数据模型
 * `FacebookGroupJoinObservation`、阶段枚举 `FacebookGroupJoinPhase` 与 `buildFacebookGroupJoinJudgePrompt`
 * 纯函数（入参→prompt 字符串，零 LLM / 零连库 / 零进程内活状态 / 零 import）。判定类 `FacebookGroupJoinJudge`
 * 与其确定性短路、LLM 调用、审计回写留原文件（automation），并从 kernel 等值再导出、行为逐字不变。
 * 供 api 侧静态 prompt 预览跨边界共导，消 1 条 api->automation 边。满足 §4.7 kernel 准入。
 */

export type FacebookGroupJoinPhase = 'pre_click' | 'post_click';

export interface FacebookGroupJoinObservation {
  groupUrl?: string;
  pageUrl?: string;
  title?: string;
  mainCtaText?: string | null;
  mainCtaAria?: string | null;
  headerText?: string | null;
  modalText?: string | null;
  membershipSignals?: string[];
  loginRequired?: boolean;
  captchaDetected?: boolean;
  questionnaireRequired?: boolean;
  pendingRequest?: boolean;
  navError?: string | null;
  /**
   * L3 结构后置校验（change facebook-join-structural-verify；与边缘同名字段第二副本，随 observation 松通道流入）：
   * 群主体内是否有可聚焦发帖/评论 composer（语言无关成员态信号）。
   */
  composerPresent?: boolean;
  /** L3：群主体内是否有可见「加入」CTA。承重闸——joined 要求 composerPresent 且 joinCtaPresent 为 false（防非成员组假成功）。 */
  joinCtaPresent?: boolean;
}

/** Runtime and admin preview share this exact prompt builder to prevent drift. */
export function buildFacebookGroupJoinJudgePrompt(
  phase: FacebookGroupJoinPhase,
  obs: FacebookGroupJoinObservation,
): string {
  const allowed =
    phase === 'pre_click'
      ? 'instant_join | gated_skip | already_member | ambiguous_skip'
      : 'joined | pending_gated | failed';
  // 只喂「加群语义信号」给 LLM，剔除页面加载诊断字段（documentReady / actionNodeCount 等）——
  // 真机事故:LLM 见 documentReady='loading' 就对明明有「加入小组」的页面保守判 ambiguous。加载态与加群判定无关。
  const signals = {
    title: obs.title,
    pageUrl: obs.pageUrl,
    mainCtaText: obs.mainCtaText,
    mainCtaAria: obs.mainCtaAria,
    headerText: obs.headerText,
    modalText: obs.modalText,
    membershipSignals: obs.membershipSignals,
    loginRequired: obs.loginRequired,
    captchaDetected: obs.captchaDetected,
    questionnaireRequired: obs.questionnaireRequired,
    pendingRequest: obs.pendingRequest,
    navError: obs.navError,
    // L3 语言无关结构信号：群主体内有可聚焦发帖/评论框 + 是否仍有可见「加入」CTA（承重成员态判据）。
    composerPresent: obs.composerPresent,
    joinCtaPresent: obs.joinCtaPresent,
  };
  return `You classify a Facebook public group join observation.

Rules:
- Fail closed. If uncertain, choose ${phase === 'pre_click' ? 'ambiguous_skip' : 'failed'}.
- Pre-click instant_join means clicking the visible Join control is likely to make this account a member immediately, without approval questions.
- Approval gates, pending requests, membership questions, login, captcha, or unclear UI must not be treated as instant join.
- A clear Join control (e.g. "加入小组" / "Join group" / "Tham gia") with no approval/pending/login/captcha signal is an instant_join; page load state is irrelevant.
- Post-click joined means the account is now visibly a member.
- Language-independent membership signal: composerPresent=true with joinCtaPresent=false (a focusable post/comment box in the group body and NO visible Join control) indicates membership even if the button text is in an unrecognized language. joinCtaPresent=true means the account is NOT yet a member (still shows a Join control), regardless of any composer.

Phase: ${phase}
Allowed verdicts: ${allowed}
Observation JSON:
${JSON.stringify(signals, null, 2)}

Return JSON only:
{"verdict":"...","confidence":0.0,"reason":"short evidence"}`;
}
