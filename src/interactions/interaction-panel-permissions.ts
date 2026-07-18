import type { InteractionGrant } from './interaction-internal-api.js';

export interface InteractionPermissionDefinition {
  key: InteractionGrant;
  name: string;
  description: string;
}

export interface InteractionPermissionView extends InteractionPermissionDefinition {
  users: string[];
}

export interface InteractionPermissionOverview {
  permissions: InteractionPermissionView[];
}

export const INTERACTION_PERMISSION_DEFINITIONS: readonly InteractionPermissionDefinition[] = [
  {
    key: 'interaction.config.view',
    name: '查看配置',
    description: '查看视频号互动运行开关、回复策略、模板、规则和品牌语气配置。',
  },
  {
    key: 'interaction.config.edit',
    name: '编辑配置',
    description: '修改并保存视频号互动运行开关和回复配置草稿。',
  },
  {
    key: 'interaction.config.publish',
    name: '发布配置',
    description: '将通过校验的回复配置草稿发布为 Cloud 正式生效版本。',
  },
  {
    key: 'interaction.config.preview',
    name: '模拟预览',
    description: '运行不会真实发送的规则、模板、AI 和风险链路预览。',
  },
  {
    key: 'interaction.dm.view_full',
    name: '查看完整私信',
    description: '在受控场景查看完整私信正文；缺少此权限时正文保持脱敏。',
  },
  {
    key: 'interaction.audit.view',
    name: '查看审计',
    description: '查看配置版本、操作者、变更时间和差异摘要等审计记录。',
  },
] as const;

export function buildInteractionPermissionOverview(
  panelUsers: readonly { username: string }[],
  grants: ReadonlyMap<string, ReadonlySet<InteractionGrant>>,
): InteractionPermissionOverview {
  const activeUsernames = [...new Set(panelUsers.map((user) => user.username))].sort((a, b) => a.localeCompare(b));
  return {
    permissions: INTERACTION_PERMISSION_DEFINITIONS.map((definition) => ({
      ...definition,
      users: activeUsernames.filter((username) => grants.get(username)?.has(definition.key) === true),
    })),
  };
}
