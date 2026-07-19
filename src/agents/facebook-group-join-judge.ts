import type { LlmCallOpts } from '../llm/qwen.js';
import type { RoleName } from '../event-bus/types.js';
import type { FacebookGroupJoinAuditRow } from '../comment-agent/facebook-group-store.js';

export type FacebookJoinPreClickVerdict = 'instant_join' | 'gated_skip' | 'already_member' | 'ambiguous_skip';
export type FacebookJoinPostClickVerdict = 'joined' | 'pending_gated' | 'failed';

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

export type FacebookGroupJoinJudgeResult =
  | { phase: 'pre_click'; verdict: FacebookJoinPreClickVerdict; confidence: number; reason: string }
  | { phase: 'post_click'; verdict: FacebookJoinPostClickVerdict; confidence: number; reason: string };

export interface FacebookGroupJoinJudgeOptions {
  llm?: { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };
  accountId?: string;
  audit?: (row: FacebookGroupJoinAuditRow) => void;
}

const ROLE_NAME: RoleName = 'facebook_group_join_judge';

function textOf(obs: FacebookGroupJoinObservation): string {
  return [
    obs.mainCtaText,
    obs.mainCtaAria,
    obs.headerText,
    obs.modalText,
    ...(obs.membershipSignals ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

// 成员/「已成为成员」多语词表（change facebook-join-comment-resilience P0-2；与边缘 MEMBER_CTA_LABELS /
// MEMBER_MEMBERSHIP_PHRASES 同源。edge / cloud 分离仓库故为第二副本——漂移守卫测试留 P1-6，勿静默分叉）。
const JUDGE_MEMBER_LABELS = [
  'joined', 'leave group', '已加入', '退出小组', '退出群组', '退出社团', 'đã tham gia', 'rời nhóm',
  'salir del grupo', 'keluar dari grup', 'quitter le groupe', 'gruppe verlassen', 'ออกจากกลุ่ม', '已是成员', '你已加入',
];
const JUDGE_MEMBER_PHRASES = [
  'you are now a member', 'member of this group', '已是成员', '你已加入', 'ahora eres miembro', 'bạn đã là thành viên',
];

/** NFKC 归一 + 收敛空白 + 小写（与边缘 normLabel 对齐）。 */
function normJudge(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 是否已是成员（多语 contains，非精确 ===，P0-2）。旧 EN/ZH 精确实现对非英中群的本地语成员标签漏判 → 落到
 * hasJoinCta 的子串误判为 instant_join（如「đã tham gia」含「tham gia」）。member 词表须先于 hasJoinCta 判（本文件
 * preClickDeterministic / postClickDeterministic 均已如此），此处补齐多语识别使短路真正生效。仍须正向命中，绝不放宽。
 */
function hasMemberSignal(obs: FacebookGroupJoinObservation): boolean {
  const hit = (s: string): boolean => s.length > 0 && JUDGE_MEMBER_LABELS.some((k) => s.includes(k));
  if (hit(normJudge(obs.mainCtaText)) || hit(normJudge(obs.mainCtaAria))) return true;
  return (obs.membershipSignals ?? []).some((signal) => {
    const s = normJudge(signal);
    if (!s) return false;
    return JUDGE_MEMBER_PHRASES.some((n) => s.includes(n)) || JUDGE_MEMBER_LABELS.some((k) => s.includes(k));
  });
}

/** 主 CTA 是否为清晰的「加入」按钮（多语，contains；与边缘分类器同语料）。 */
// 「加入」多语按钮词表（P1-6：与边缘 JOIN_CTA_LABELS 逐词对齐，补齐此前漂移缺失的 entrar al/no grupo / เข้าร่วม /
// вступить / sertai / انضمام / انضم。edge / cloud 分离仓库故为第二副本——drift-guard 测试见 judge 测试，勿静默分叉）。
const JUDGE_JOIN_LABELS = [
  'join group', 'join', '加入小组', '加入群组', '加入社团', '加入', 'tham gia', 'únete', 'unirte', 'participar',
  'entrar al grupo', 'entrar no grupo', 'gabung', 'bergabung', 'เข้าร่วม', 'rejoindre', 'beitreten', 'iscriviti',
  'вступить', 'присоединиться', '참여', '가입', 'انضمام', 'انضم', 'sertai',
];

function hasJoinCta(obs: FacebookGroupJoinObservation): boolean {
  const cta = normJudge(obs.mainCtaText);
  const aria = normJudge(obs.mainCtaAria);
  if (!cta && !aria) return false;
  return JUDGE_JOIN_LABELS.some((k) => cta.includes(k) || aria.includes(k));
}

/**
 * L3 结构确认加入（change facebook-join-structural-verify）——**承重 = 语言无关、点击可归因的「跃迁」**：composer 点前无、点后有。
 * 修正后核心（对抗评审揪出）：不能只靠「点后无可见加入 CTA」当正向，因 joinCtaPresent 由词表派生、未覆盖语种会 fail-open→
 * 非成员误判假成功。跃迁不依赖词表：非成员公开组点前已有 composer → 无跃迁不误判；`!joinCtaPresent` 仅 corroborating。
 * 仅用于 post-click（有点击）；pre-click 无点击、绝不据结构判 already_member（会没点击就 markJoined、污染账本）。
 * 与边缘 structuralJoinConfirmed 同源（edge/cloud 分离仓库、第二副本）。
 */
function structuralJoinConfirmed(
  pre: FacebookGroupJoinObservation | undefined,
  post: FacebookGroupJoinObservation,
): boolean {
  if (pre?.composerPresent === true) return false; // 点前已有 composer（如公开组对非成员）→ 非跃迁，绝不认
  return post.composerPresent === true && post.joinCtaPresent !== true;
}

function parseConfidence(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export type FacebookGroupJoinPhase = 'pre_click' | 'post_click';

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

export class FacebookGroupJoinJudge {
  readonly roleName: RoleName = ROLE_NAME;
  private readonly llm?: FacebookGroupJoinJudgeOptions['llm'];
  private readonly accountId?: string;
  private readonly audit?: (row: FacebookGroupJoinAuditRow) => void;

  constructor(options: FacebookGroupJoinJudgeOptions = {}) {
    this.llm = options.llm;
    this.accountId = options.accountId;
    this.audit = options.audit;
  }

  async evaluatePreClick(observation: FacebookGroupJoinObservation): Promise<FacebookGroupJoinJudgeResult> {
    const deterministic = this.preClickDeterministic(observation);
    const result = deterministic ?? (await this.askModel('pre_click', observation));
    this.record(observation, result);
    return result;
  }

  async evaluatePostClick(
    observation: FacebookGroupJoinObservation,
    /** 同一次 click 内的点前观测——供 L3「跃迁」判据（composer 点前无、点后有）。缺省则跃迁不成立、结构不 joined。 */
    preObservation?: FacebookGroupJoinObservation,
  ): Promise<FacebookGroupJoinJudgeResult> {
    const deterministic = this.postClickDeterministic(observation, preObservation);
    const result = deterministic ?? (await this.askModel('post_click', observation));
    this.record(observation, result);
    return result;
  }

  private preClickDeterministic(obs: FacebookGroupJoinObservation): FacebookGroupJoinJudgeResult | null {
    if (obs.loginRequired) return { phase: 'pre_click', verdict: 'ambiguous_skip', confidence: 1, reason: 'login_required' };
    if (obs.captchaDetected) return { phase: 'pre_click', verdict: 'ambiguous_skip', confidence: 1, reason: 'captcha_detected' };
    if (obs.navError) return { phase: 'pre_click', verdict: 'ambiguous_skip', confidence: 1, reason: `nav_error:${obs.navError}` };
    const text = textOf(obs);
    if (hasMemberSignal(obs)) {
      return { phase: 'pre_click', verdict: 'already_member', confidence: 0.95, reason: 'member_signal' };
    }
    if (
      obs.questionnaireRequired ||
      obs.pendingRequest ||
      hasAny(text, [
        'answer questions', 'membership questions', 'pending', 'approval', 'request to join',
        '回答问题', '待批准', '待审批', '申请加入', '取消请求', '取消加入请求', '取消申请', '已发送请求',
      ])
    ) {
      return { phase: 'pre_click', verdict: 'gated_skip', confidence: 0.95, reason: 'gated_or_questionnaire_signal' };
    }
    // L3：pre-click **不据结构判 already_member**（对抗评审揪出）——此处无点击，joinCtaPresent 词表派生会 fail-open，
    // 结构 already_member 会没点击就 markJoined、污染账本、在没加入的群假评论。结构判定仅用于 post-click 的「跃迁」。
    // 已排除 登录/验证码/nav_error/成员/门槛/待审后，若有清晰的「加入」CTA → 确定性 instant_join（不问 LLM）。
    // 修复真机 fail-closed:LLM 因观察里的 documentReady='loading' 诊断字段对明明有「加入小组」的页面保守判 ambiguous。
    // 页面加载态不该左右加群判定;是否审批门在点击后揭示（post-click 有 pending/questionnaire 兜底，不会假成功）。
    if (hasJoinCta(obs)) {
      return { phase: 'pre_click', verdict: 'instant_join', confidence: 0.9, reason: 'clear_join_cta' };
    }
    return null;
  }

  private postClickDeterministic(
    obs: FacebookGroupJoinObservation,
    preObs?: FacebookGroupJoinObservation,
  ): FacebookGroupJoinJudgeResult | null {
    if (obs.loginRequired) return { phase: 'post_click', verdict: 'failed', confidence: 1, reason: 'login_required' };
    if (obs.captchaDetected) return { phase: 'post_click', verdict: 'failed', confidence: 1, reason: 'captcha_detected' };
    if (obs.navError) return { phase: 'post_click', verdict: 'failed', confidence: 1, reason: `nav_error:${obs.navError}` };
    const text = textOf(obs);
    if (hasMemberSignal(obs)) {
      return { phase: 'post_click', verdict: 'joined', confidence: 0.95, reason: 'member_signal' };
    }
    if (
      obs.questionnaireRequired ||
      obs.pendingRequest ||
      hasAny(text, [
        'pending', 'approval', 'request sent', 'membership questions',
        '待批准', '待审批', '已申请', '回答问题', '取消请求', '取消加入请求', '取消申请', '已发送请求',
      ])
    ) {
      return { phase: 'post_click', verdict: 'pending_gated', confidence: 0.95, reason: 'pending_or_questionnaire_signal' };
    }
    // L3 结构主判（承重 = 语言无关「跃迁」，pending/问卷之后）：composer 点前无、点后有 → 点击真让本账号成为成员 → joined。
    // 消灭「重复加群」：未覆盖语种的加入不再落 LLM fail-closed→failed→重复。非成员公开组点前已有 composer → 无跃迁、不假成功。
    if (structuralJoinConfirmed(preObs, obs)) {
      return { phase: 'post_click', verdict: 'joined', confidence: 0.9, reason: 'structural_join_transition' };
    }
    return null;
  }

  private async askModel(
    phase: 'pre_click' | 'post_click',
    obs: FacebookGroupJoinObservation,
  ): Promise<FacebookGroupJoinJudgeResult> {
    if (!this.llm) {
      return phase === 'pre_click'
        ? { phase, verdict: 'ambiguous_skip', confidence: 0, reason: 'no_llm_fail_closed' }
        : { phase, verdict: 'failed', confidence: 0, reason: 'no_llm_fail_closed' };
    }
    let raw: string;
    try {
      raw = await this.llm.complete(buildFacebookGroupJoinJudgePrompt(phase, obs), { role: `browse:${ROLE_NAME}` });
    } catch (err) {
      return phase === 'pre_click'
        ? { phase, verdict: 'ambiguous_skip', confidence: 0, reason: `llm_error:${(err as Error).message}` }
        : { phase, verdict: 'failed', confidence: 0, reason: `llm_error:${(err as Error).message}` };
    }
    return this.parseModelResult(phase, raw);
  }

  private parseModelResult(phase: 'pre_click' | 'post_click', raw: string): FacebookGroupJoinJudgeResult {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return phase === 'pre_click'
        ? { phase, verdict: 'ambiguous_skip', confidence: 0, reason: 'invalid_json' }
        : { phase, verdict: 'failed', confidence: 0, reason: 'invalid_json' };
    }
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const verdict = typeof obj.verdict === 'string' ? obj.verdict : '';
      const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim().slice(0, 240) : 'model_verdict';
      const confidence = parseConfidence(obj.confidence, 0);
      if (phase === 'pre_click') {
        if (verdict === 'instant_join' && confidence >= 0.8) return { phase, verdict, confidence, reason };
        if (verdict === 'gated_skip') return { phase, verdict, confidence, reason };
        if (verdict === 'already_member') return { phase, verdict, confidence, reason };
        return { phase, verdict: 'ambiguous_skip', confidence, reason: `fail_closed:${reason}` };
      }
      if (verdict === 'joined' && confidence >= 0.8) return { phase, verdict, confidence, reason };
      if (verdict === 'pending_gated') return { phase, verdict, confidence, reason };
      return { phase, verdict: 'failed', confidence, reason: `fail_closed:${reason}` };
    } catch {
      return phase === 'pre_click'
        ? { phase, verdict: 'ambiguous_skip', confidence: 0, reason: 'invalid_json' }
        : { phase, verdict: 'failed', confidence: 0, reason: 'invalid_json' };
    }
  }

  private record(obs: FacebookGroupJoinObservation, result: FacebookGroupJoinJudgeResult): void {
    if (!this.audit || !this.accountId) return;
    try {
      this.audit({
        accountId: this.accountId,
        groupUrl: obs.groupUrl ?? obs.pageUrl ?? null,
        phase: result.phase,
        outcome:
          result.phase === 'pre_click'
            ? result.verdict === 'instant_join'
              ? 'shadow_observed'
              : result.verdict
            : result.verdict === 'pending_gated'
              ? 'pending'
              : result.verdict === 'failed'
                ? 'join_failed'
                : result.verdict,
        verdict: result.verdict,
        reason: result.reason,
        shadow: true,
        observation: obs,
      });
    } catch {
      /* audit is best-effort */
    }
  }
}
