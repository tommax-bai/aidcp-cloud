import type { InteractionRuntimeControlsPayload, RuntimeControls } from '../kernel/interaction-types.js';

export interface RuntimeControlsProjectionDeps {
  getRuntimeControls(accountId: string): Promise<RuntimeControls>;
  hasPendingOffboard(accountId: string): Promise<boolean>;
  hasPendingRevocationHold(accountId: string): Promise<boolean>;
  globalWriteEnabled: boolean;
}

/** Projects stored controls into the fail-closed snapshot sent to one account's Edge. */
export async function projectRuntimeControls(
  deps: RuntimeControlsProjectionDeps,
  accountId: string,
): Promise<InteractionRuntimeControlsPayload> {
  const controls = await deps.getRuntimeControls(accountId);
  const envKey = controls.envKey?.trim() ?? '';
  const [offboardPending, revocationHoldPending] = await Promise.all([
    deps.hasPendingOffboard(accountId),
    deps.hasPendingRevocationHold(accountId),
  ]);
  const scopeValid = controls.accountId === accountId && envKey.length > 0;
  const readAllowed = scopeValid && !offboardPending && !revocationHoldPending;
  const writeAllowed = readAllowed && deps.globalWriteEnabled && !controls.writePaused;
  return {
    accountId,
    envKey,
    version: controls.version,
    commentsReadEnabled: readAllowed && controls.commentsReadEnabled,
    commentsReplyEnabled: writeAllowed && controls.commentsReplyEnabled,
    dmReadEnabled: readAllowed && controls.dmReadEnabled,
    dmSendTextEnabled: writeAllowed && controls.dmSendTextEnabled,
    dmSendImageEnabled: false,
  };
}
