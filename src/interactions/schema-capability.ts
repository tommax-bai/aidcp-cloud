export type InteractionSchemaMode = 'full' | 'legacy_read_only';

export interface InteractionSchemaShape {
  basePresent: boolean;
  activeAttemptIndexPresent: boolean;
  legacyRetryableColumnPresent: boolean;
}

export function classifyInteractionSchema(shape: InteractionSchemaShape): InteractionSchemaMode {
  if (!shape.basePresent) throw new Error('interaction_schema_missing_run_0042');
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
