/**
 * 注册表（期1-6）出口：任务定义 / 能力定义的组合根解析口。
 *
 * 期1 生产注册表只发布 persona 只读研究一种任务（persona-research.ts）。
 * 解析不到一律返回 null——服务层以 'unsupported' 如实拒绝（不猜版本、不近似回退），
 * 注册表本身不做准入判断：写动作照样能注册进来（测试缝就是为此），
 * 准入闸的唯一事实源仍是 plan-compiler 的编译规则 4。
 */

import type { CapabilityDefinition, TaskDefinition } from '../contracts/capability.js';
import type { CapabilityResolver } from '../engine/plan-compiler.js';
import type { TaskDefinitionResolver } from '../service/task-entry-service.js';
import {
  PERSONA_RESEARCH_CAPABILITIES,
  PERSONA_RESEARCH_TASK_DEFINITION,
} from './persona-research.js';

export {
  PERSONA_RESEARCH_CAPABILITIES,
  PERSONA_RESEARCH_CAPABILITY_IDS,
  PERSONA_RESEARCH_MAX_ITEMS_CAP,
  PERSONA_RESEARCH_TASK_DEFINITION,
  PERSONA_RESEARCH_TASK_DEFINITION_ID,
  PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
  parsePersonaResearchParams,
  type PersonaResearchCapabilityId,
  type PersonaResearchParams,
  type PersonaResearchParamsResult,
} from './persona-research.js';

export interface ManagedAutomationRegistry {
  resolveTaskDefinition: TaskDefinitionResolver;
  resolveCapability: CapabilityResolver;
}

export interface ManagedAutomationRegistryOptions {
  /** 测试缝：追加定义/能力以验证准入闸（生产组合根不传，只发布 persona 研究）。 */
  additionalDefinitions?: readonly TaskDefinition[];
  additionalCapabilities?: readonly CapabilityDefinition[];
}

/**
 * 构造注册表：Map 键 `${id}@${version}`，构造期冻结（无运行期注册入口）。
 * 键冲突当场抛错——测试缝不允许悄悄覆盖生产条目。
 */
export function createManagedAutomationRegistry(
  options: ManagedAutomationRegistryOptions = {},
): ManagedAutomationRegistry {
  const definitions = new Map<string, TaskDefinition>();
  const capabilities = new Map<string, CapabilityDefinition>();
  for (const definition of [PERSONA_RESEARCH_TASK_DEFINITION, ...(options.additionalDefinitions ?? [])]) {
    const key = `${definition.taskDefinitionId}@${definition.version}`;
    if (definitions.has(key)) throw new Error(`任务定义重复注册：${key}`);
    definitions.set(key, definition);
  }
  for (const capability of [...PERSONA_RESEARCH_CAPABILITIES, ...(options.additionalCapabilities ?? [])]) {
    const key = `${capability.capabilityId}@${capability.version}`;
    if (capabilities.has(key)) throw new Error(`能力定义重复注册：${key}`);
    capabilities.set(key, capability);
  }
  return {
    resolveTaskDefinition: (taskDefinitionId, version) =>
      definitions.get(`${taskDefinitionId}@${version}`) ?? null,
    resolveCapability: (capabilityId, version) =>
      capabilities.get(`${capabilityId}@${version}`) ?? null,
  };
}
