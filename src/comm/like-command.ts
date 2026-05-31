/**
 * 点赞命令服务（云端）。
 *
 * 把"高层意图：给当前笔记点赞"翻译成有序原子步骤（经 planner 拆解），
 * 并通过 EdgePusher 主动下发给已上线的边缘节点执行。
 *
 * 这是云端"发起命令"侧的最小封装：trigger-like CLI 或上层业务都可调用它，
 * 不直接依赖网络细节（推送通过注入的 EdgePusher 完成）。
 */

import { makeEnvelope, type Envelope, type PlanStep } from './protocol.js';
import type { EdgePusher } from './ws-server.js';
import type { TaskPlanner } from '../planner/types.js';

/** 默认点赞意图（喂给 planner 命中"点赞"规则） */
export const DEFAULT_LIKE_GOAL = '给当前这条笔记点赞';

export interface LikeCommandDeps {
  planner: TaskPlanner;
  /** 注入时钟（测试用） */
  clock?: () => number;
  /** id 生成器（测试用） */
  idGen?: () => string;
}

export interface LikeDispatchResult {
  /** 下发的步骤 */
  steps: PlanStep[];
  /** planner 说明 */
  reason: string;
  /** 实际送达的边缘连接数 */
  dispatched: number;
  /** 下发的信封（便于观测/测试） */
  envelope: Envelope;
}

/** 点赞命令服务：规划 + 下发 */
export class LikeCommandService {
  private readonly clock: () => number;
  private seq = 0;
  private readonly idGen: () => string;

  constructor(private readonly deps: LikeCommandDeps) {
    this.clock = deps.clock ?? Date.now;
    this.idGen = deps.idGen ?? (() => `like-${++this.seq}`);
  }

  /**
   * 规划点赞并下发给边缘。
   * @param pusher  边缘推送器（通常是 EdgeCloudServer 本身）
   * @param edgeId  可选定向到某个 edgeId；不传则广播给所有已上线边缘
   * @param goal    可覆盖默认点赞目标
   */
  async dispatchLike(
    pusher: EdgePusher,
    edgeId?: string,
    goal: string = DEFAULT_LIKE_GOAL,
  ): Promise<LikeDispatchResult> {
    const plan = await this.deps.planner.plan({ goal });
    const envelope = makeEnvelope('plan.response', this.idGen(), this.clock(), {
      steps: plan.steps,
      reason: plan.reason,
    });
    let dispatched = 0;
    if (plan.steps.length > 0) {
      dispatched = pusher.pushToEdges(envelope, edgeId);
    }
    return { steps: plan.steps, reason: plan.reason, dispatched, envelope };
  }
}
