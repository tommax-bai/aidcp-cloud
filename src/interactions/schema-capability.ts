export type InteractionSchemaMode = 'full' | 'legacy_read_only';

export interface InteractionSchemaShape {
  basePresent: boolean;
  activeAttemptIndexPresent: boolean;
  legacyRetryableColumnPresent: boolean;
  /**
   * 基础形状里**具体缺了哪几个对象**。
   *
   * 加这一项是因为原来那条错误名（只点一个迁移号）把排查方向带偏过一次：基础形状是
   * 好几个对象的**与**，报出来的却是其中一个迁移号 —— 2026-08-04 dev 上实际缺的是另一张表，
   * 而被点名的那个迁移**早就应用了、列也在**，于是查的人先翻迁移账本、再比对列，全程走错方向。
   * **缺什么就说什么。**
   */
  missingBaseObjects?: readonly string[];
}

export function classifyInteractionSchema(shape: InteractionSchemaShape): InteractionSchemaMode {
  if (!shape.basePresent) {
    throw new Error(
      'interaction_schema_base_incomplete'
        + (shape.missingBaseObjects?.length
          ? `：缺 ${shape.missingBaseObjects.join(', ')}`
          : '（未采集具体缺失项）'),
    );
  }
  if (shape.activeAttemptIndexPresent && !shape.legacyRetryableColumnPresent) return 'full';
  if (!shape.activeAttemptIndexPresent && shape.legacyRetryableColumnPresent) return 'legacy_read_only';
  throw new Error('interaction_schema_inconsistent_run_0046');
}

export function interactionWritesAllowed(
  schemaMode: InteractionSchemaMode | undefined,
  configuredGlobalWriteEnabled: boolean,
  deploymentEnvironment?: string,
): boolean {
  if (!configuredGlobalWriteEnabled) return false;
  return schemaMode === 'full' || (
    schemaMode === 'legacy_read_only' && deploymentEnvironment?.trim() === 'dev'
  );
}
