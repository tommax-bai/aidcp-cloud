import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type SurfaceDirection =
  | 'automation-to-api'
  | 'api-to-automation'
  | 'api-to-content';

export interface SurfaceBinding {
  id: string;
  direction: SurfaceDirection;
  interfaceName: string;
  transportFile: string;
  routesConstant: string;
  registerFunction: string;
  clientClass: string;
}

export interface DerivedSurfaceGroup {
  id: string;
  direction: SurfaceDirection;
  methods: string[];
  routeMethods: string[];
  registeredRouteMethods: string[];
  clientMethods: string[];
  productionConsumerMethods: string[];
  productionConsumerCallSites: Record<string, string[]>;
  productionRegistration: boolean;
  productionClient: boolean;
}

export interface DerivedAlternate {
  id: 'pending-publish-scan' | 'publish-preview-projection';
  selected: string | null;
}

export interface DerivedBlocker {
  id: string;
  category: '4b-mirror' | 'operator-command' | 'content-owner' | 'composition-root';
  owner: string;
  consumer: string;
  closingChange: 'split-cloud-api-composition-root-4b' | 'future';
  evidence: string[];
}

interface ProductionConsumerBinding {
  groupId: string;
  method: string;
  sourceFile: string;
  callPath: string;
}

interface EvidenceProbe {
  sourceFile: string;
  scope?: string;
  kind: 'call' | 'new' | 'identifier' | 'text';
  symbol: string;
}

interface BlockerBinding extends Omit<DerivedBlocker, 'evidence'> {
  probes: readonly EvidenceProbe[];
}

interface OwnershipEntry {
  path: string;
  layer: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

/**
 * This mapping names declarations; it does not carry method lists. Method
 * truth is derived from the compiler AST in kernel contracts, transport route
 * objects/handlers/clients, and the production composition root.
 */
export const SURFACE_BINDINGS: readonly SurfaceBinding[] = [
  {
    id: 'account-roster-source',
    direction: 'automation-to-api',
    interfaceName: 'AccountRosterAuthorityPort',
    transportFile: 'src/transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_ROSTER_ROUTES',
    registerFunction: 'registerAccountRosterRoutes',
    clientClass: 'AccountRosterHttpClient',
  },
  {
    id: 'account-ownership',
    direction: 'automation-to-api',
    interfaceName: 'AccountOwnershipAuthorityPort',
    transportFile: 'src/transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_OWNERSHIP_ROUTES',
    registerFunction: 'registerAccountOwnershipRoutes',
    clientClass: 'AccountOwnershipHttpClient',
  },
  {
    id: 'account-runtime-authority',
    direction: 'automation-to-api',
    interfaceName: 'AccountRuntimeAuthorityPort',
    transportFile: 'src/transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_RUNTIME_ROUTES',
    registerFunction: 'registerAccountRuntimeRoutes',
    clientClass: 'AccountRuntimeHttpClient',
  },
  {
    id: 'publish-log-for-automation',
    direction: 'automation-to-api',
    interfaceName: 'AutomationPublishLogPort',
    transportFile: 'src/transport/api-publish-interaction-http.ts',
    routesConstant: 'AUTOMATION_PUBLISH_LOG_ROUTES',
    registerFunction: 'registerAutomationPublishLogRoutes',
    clientClass: 'AutomationPublishLogHttpClient',
  },
  {
    id: 'edge-publish-commands',
    direction: 'automation-to-api',
    interfaceName: 'EdgePublishCommandPort',
    transportFile: 'src/transport/api-publish-interaction-http.ts',
    routesConstant: 'EDGE_PUBLISH_COMMAND_ROUTES',
    registerFunction: 'registerEdgePublishCommandRoutes',
    clientClass: 'EdgePublishCommandHttpClient',
  },
  {
    id: 'interaction-auth-gate',
    direction: 'automation-to-api',
    interfaceName: 'InteractionAuthAuthorityPort',
    transportFile: 'src/transport/api-publish-interaction-http.ts',
    routesConstant: 'INTERACTION_AUTH_ROUTES',
    registerFunction: 'registerInteractionAuthRoutes',
    clientClass: 'InteractionAuthHttpClient',
  },
  {
    id: 'interaction-api-writes',
    direction: 'automation-to-api',
    interfaceName: 'InteractionApiWritesPort',
    transportFile: 'src/transport/api-publish-interaction-http.ts',
    routesConstant: 'INTERACTION_API_WRITES_ROUTES',
    registerFunction: 'registerInteractionApiWritesRoutes',
    clientClass: 'InteractionApiWritesHttpClient',
  },
  {
    id: 'reply-config-resolver',
    direction: 'automation-to-api',
    interfaceName: 'ReplyConfigResolverPort',
    transportFile: 'src/transport/api-publish-interaction-http.ts',
    routesConstant: 'REPLY_CONFIG_RESOLVER_ROUTES',
    registerFunction: 'registerReplyConfigResolverRoutes',
    clientClass: 'ReplyConfigResolverHttpClient',
  },
  {
    id: 'account-persona',
    direction: 'automation-to-api',
    interfaceName: 'AccountPersonaAuthorityPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'ACCOUNT_PERSONA_ROUTES',
    registerFunction: 'registerAccountPersonaRoutes',
    clientClass: 'AccountPersonaHttpClient',
  },
  {
    id: 'environment-handshake',
    direction: 'automation-to-api',
    interfaceName: 'EnvironmentHandshakePort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'ENVIRONMENT_HANDSHAKE_ROUTES',
    registerFunction: 'registerEnvironmentHandshakeRoutes',
    clientClass: 'EnvironmentHandshakeHttpClient',
  },
  {
    id: 'comment-approval-policy',
    direction: 'automation-to-api',
    interfaceName: 'CommentApprovalPolicyPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'COMMENT_APPROVAL_POLICY_ROUTES',
    registerFunction: 'registerCommentApprovalPolicyRoutes',
    clientClass: 'CommentApprovalPolicyHttpClient',
  },
  {
    id: 'notification-contacts',
    direction: 'automation-to-api',
    interfaceName: 'NotificationContactsPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'NOTIFICATION_CONTACTS_ROUTES',
    registerFunction: 'registerNotificationContactsRoutes',
    clientClass: 'NotificationContactsHttpClient',
  },
  {
    id: 'first-post-progress',
    direction: 'automation-to-api',
    interfaceName: 'FirstPostProgressPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'FIRST_POST_PROGRESS_ROUTES',
    registerFunction: 'registerFirstPostProgressRoutes',
    clientClass: 'FirstPostProgressHttpClient',
  },
  {
    id: 'automation-config-commands',
    direction: 'automation-to-api',
    interfaceName: 'AutomationConfigCommandsPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'AUTOMATION_CONFIG_COMMANDS_ROUTES',
    registerFunction: 'registerAutomationConfigCommandsRoutes',
    clientClass: 'AutomationConfigCommandsHttpClient',
  },
  {
    id: 'offboard-admission-ledger',
    direction: 'automation-to-api',
    interfaceName: 'OffboardAdmissionLedgerPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'OFFBOARD_ADMISSION_LEDGER_ROUTES',
    registerFunction: 'registerOffboardAdmissionLedgerRoutes',
    clientClass: 'OffboardAdmissionLedgerHttpClient',
  },
  {
    id: 'api-notification-exit',
    direction: 'automation-to-api',
    interfaceName: 'StructuredNotificationDeliveryPort',
    transportFile: 'src/transport/api-aux-authority-http.ts',
    routesConstant: 'STRUCTURED_NOTIFICATION_ROUTES',
    registerFunction: 'registerStructuredNotificationRoutes',
    clientClass: 'StructuredNotificationHttpClient',
  },
  {
    id: 'edge-resume-command',
    direction: 'api-to-automation',
    interfaceName: 'EdgeResumeCommandPort',
    transportFile: 'src/transport/paired-command-http.ts',
    routesConstant: 'EDGE_RESUME_COMMAND_ROUTES',
    registerFunction: 'registerEdgeResumeCommandRoutes',
    clientClass: 'EdgeResumeCommandHttpClient',
  },
  {
    id: 'facebook-scope-commands',
    direction: 'api-to-automation',
    interfaceName: 'FacebookScopeCommandPort',
    transportFile: 'src/transport/paired-command-http.ts',
    routesConstant: 'FACEBOOK_SCOPE_COMMAND_ROUTES',
    registerFunction: 'registerFacebookScopeCommandRoutes',
    clientClass: 'FacebookScopeCommandHttpClient',
  },
  {
    id: 'publish-ui-update',
    direction: 'api-to-automation',
    interfaceName: 'PublishUiUpdateCommandPort',
    transportFile: 'src/transport/paired-command-http.ts',
    routesConstant: 'PUBLISH_UI_UPDATE_COMMAND_ROUTES',
    registerFunction: 'registerPublishUiUpdateCommandRoutes',
    clientClass: 'PublishUiUpdateCommandHttpClient',
  },
  {
    id: 'persona-generator',
    direction: 'api-to-content',
    interfaceName: 'PersonaGeneratorAuthorityPort',
    transportFile: 'src/transport/paired-command-http.ts',
    routesConstant: 'PERSONA_GENERATOR_COMMAND_ROUTES',
    registerFunction: 'registerPersonaGeneratorCommandRoutes',
    clientClass: 'PersonaGeneratorCommandHttpClient',
  },
] as const;

/**
 * Every admitted slot must have a real production consumer call. This is
 * intentionally independent from the reviewed inventory JSON: adding an
 * interface/client method cannot satisfy the census unless one of these
 * anchors still resolves to a call expression in production source.
 */
export const PRODUCTION_CONSUMER_BINDINGS: readonly ProductionConsumerBinding[] = [
  {
    groupId: 'account-roster-source',
    method: 'listAccountIdentities',
    sourceFile: 'src/transport/account-projection-store.ts',
    callPath: 'this.source.listAccountIdentities',
  },
  {
    groupId: 'account-ownership',
    method: 'getExecutionTarget',
    sourceFile: 'src/orchestrator/connection-runtime.ts',
    callPath: 'port.getExecutionTarget',
  },
  {
    groupId: 'account-ownership',
    method: 'resolveExecutionTarget',
    sourceFile: 'src/risk/pg-risk-store.ts',
    callPath: 'this.ownershipReader.resolveExecutionTarget',
  },
  {
    groupId: 'account-ownership',
    method: 'setExecutionTarget',
    sourceFile: 'src/orchestrator/connection-runtime.ts',
    callPath: 'port.setExecutionTarget',
  },
  {
    groupId: 'account-runtime-authority',
    method: 'ensureAccount',
    sourceFile: 'src/orchestrator/connection-runtime.ts',
    callPath: 'this.deps.ensureAccount',
  },
  {
    groupId: 'account-runtime-authority',
    method: 'getPlatformOrNull',
    sourceFile: 'src/interactions/interaction-store.ts',
    callPath: 'this.requireAccountPlatform().getPlatformOrNull',
  },
  {
    groupId: 'account-runtime-authority',
    method: 'getContactInfo',
    sourceFile: 'src/comment-agent/comment-scheduler.ts',
    callPath: 'this.deps.getContactInfo',
  },
  {
    groupId: 'account-runtime-authority',
    method: 'recordNickname',
    sourceFile: 'src/orchestrator/connection-runtime.ts',
    callPath: 'this.deps.recordNickname',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'loadForDispatch',
    sourceFile: 'src/publish-agent/publish-dispatcher.ts',
    callPath: 'this.store.loadForDispatch',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'updateStatus',
    sourceFile: 'src/publish-agent/publish-dispatcher.ts',
    callPath: 'this.store.updateStatus',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'updatePostId',
    sourceFile: 'src/publish-agent/publish-dispatcher.ts',
    callPath: 'this.store.updatePostId',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'markScheduled',
    sourceFile: 'src/publish-agent/publish-dispatcher.ts',
    callPath: 'this.store.markScheduled',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'markImagesAttached',
    sourceFile: 'src/publish-agent/publish-dispatcher.ts',
    callPath: 'this.store.markImagesAttached',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'listDueScheduled',
    sourceFile: 'src/publish-agent/scheduled-publish-reconciler.ts',
    callPath: 'this.deps.store.listDueScheduled',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'deferScheduledReconcile',
    sourceFile: 'src/publish-agent/scheduled-publish-reconciler.ts',
    callPath: 'this.deps.store.deferScheduledReconcile',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'confirmScheduledPublished',
    sourceFile: 'src/publish-agent/scheduled-publish-reconciler.ts',
    callPath: 'this.deps.store.confirmScheduledPublished',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'getMostRecentPublishTime',
    sourceFile: 'src/publish-agent/publish-scheduler.ts',
    callPath: 'this.d.publishLog.getMostRecentPublishTime',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'recentPublishedContents',
    sourceFile: 'src/publish-agent/publish-scheduler.ts',
    callPath: 'this.d.publishLog.recentPublishedContents',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'editDraft',
    sourceFile: 'src/publish-agent/client-publish-approval.ts',
    callPath: 'deps.editDraft',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'rejectPendingApproval',
    sourceFile: 'src/server.ts',
    callPath: 'automationPublishLog.rejectPendingApproval',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'pendingApprovalForAccount',
    sourceFile: 'src/comm/ui-snapshot.ts',
    callPath: 'this.deps.pendingApprovalForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'pendingPublishPreviewForAccount',
    sourceFile: 'src/comm/ui-snapshot.ts',
    callPath: 'this.deps.pendingPublishPreviewForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'lastPublishedForAccount',
    sourceFile: 'src/comm/ui-snapshot.ts',
    callPath: 'this.deps.lastPublishedForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'countPendingForAccount',
    sourceFile: 'src/onboarding/first-post-onboarding-coordinator.ts',
    callPath: 'this.deps.countPendingForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'countPendingAutonomousForAccount',
    sourceFile: 'src/server.ts',
    callPath: 'automationPublishLog.countPendingAutonomousForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'countPublishedTodayForAccount',
    sourceFile: 'src/server.ts',
    callPath: 'automationPublishLog.countPublishedTodayForAccount',
  },
  {
    groupId: 'publish-log-for-automation',
    method: 'countPublishedSinceForAccount',
    sourceFile: 'src/server.ts',
    callPath: 'automationPublishLog.countPublishedSinceForAccount',
  },
  {
    groupId: 'edge-publish-commands',
    method: 'removeDraftImage',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.edgePublish.removeDraftImage',
  },
  {
    groupId: 'edge-publish-commands',
    method: 'decidePublishApproval',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.edgePublish.decidePublishApproval',
  },
  {
    groupId: 'interaction-auth-gate',
    method: 'authorizeAuthStateWrite',
    sourceFile: 'src/interactions/interaction-store.ts',
    callPath: 'this.requireAuthGate().authorizeAuthStateWrite',
  },
  {
    groupId: 'interaction-auth-gate',
    method: 'checkAccountScope',
    sourceFile: 'src/interactions/interaction-store.ts',
    callPath: 'this.requireAuthGate().checkAccountScope',
  },
  {
    groupId: 'interaction-api-writes',
    method: 'insertAuditEvent',
    sourceFile: 'src/server.ts',
    callPath: 'interactionApiWrites.insertAuditEvent',
  },
  {
    groupId: 'interaction-api-writes',
    method: 'purgeReplyConfigForAccount',
    sourceFile: 'src/interactions/interaction-store.ts',
    callPath: 'this.requireApiPurge().purgeReplyConfigForAccount',
  },
  {
    groupId: 'interaction-api-writes',
    method: 'purgeExpiredAuditEvents',
    sourceFile: 'src/interactions/interaction-store.ts',
    callPath: 'this.requireApiPurge().purgeExpiredAuditEvents',
  },
  {
    groupId: 'reply-config-resolver',
    method: 'resolve',
    sourceFile: 'src/interactions/interaction-scope-internal-api.ts',
    callPath: 'this.deps.resolver.resolve',
  },
  {
    groupId: 'reply-config-resolver',
    method: 'getPublished',
    sourceFile: 'src/kernel/interaction-reply-contract.ts',
    callPath: 'reader.getPublished',
  },
  {
    groupId: 'reply-config-resolver',
    method: 'getSnapshotForJob',
    sourceFile: 'src/kernel/interaction-reply-contract.ts',
    callPath: 'reader.getSnapshotForJob',
  },
  {
    groupId: 'account-persona',
    method: 'generate',
    sourceFile: 'src/comm/handler.ts',
    callPath: 'this.deps.personaService.generate',
  },
  {
    groupId: 'account-persona',
    method: 'persist',
    sourceFile: 'src/comm/handler.ts',
    callPath: 'this.deps.personaService.persist',
  },
  {
    groupId: 'environment-handshake',
    method: 'registerHandshakeEnvironment',
    sourceFile: 'src/server.ts',
    callPath: 'environmentRegistryPort.registerHandshakeEnvironment',
  },
  {
    groupId: 'comment-approval-policy',
    method: 'getAccountCommentMode',
    sourceFile: 'src/server.ts',
    callPath: 'policy.getAccountCommentMode',
  },
  {
    groupId: 'notification-contacts',
    method: 'appendEvents',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.notificationContacts.appendEvents',
  },
  {
    groupId: 'first-post-progress',
    method: 'getFirstPostProgress',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.firstPostProgress.getFirstPostProgress',
  },
  {
    groupId: 'automation-config-commands',
    method: 'countContactAttemptsToday',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.automationConfigCommands.countContactAttemptsToday',
  },
  {
    groupId: 'automation-config-commands',
    method: 'recordContactCommentAttempt',
    sourceFile: 'src/server.ts',
    callPath: 'configCommands.recordContactCommentAttempt',
  },
  {
    groupId: 'automation-config-commands',
    method: 'resolveFacebookContainerName',
    sourceFile: 'src/server.ts',
    callPath: 'apiDirectPorts.automationConfigCommands.resolveFacebookContainerName',
  },
  {
    groupId: 'offboard-admission-ledger',
    method: 'reconcileActiveOffboardSnapshot',
    sourceFile: 'src/interactions/offboard-admission-reconciler.ts',
    callPath: 'this.deps.admissionLedger.reconcileActiveOffboardSnapshot',
  },
  {
    groupId: 'offboard-admission-ledger',
    method: 'claimPendingMaterializations',
    sourceFile: 'src/interactions/offboard-admission-reconciler.ts',
    callPath: 'this.deps.admissionLedger.claimPendingMaterializations',
  },
  {
    groupId: 'offboard-admission-ledger',
    method: 'recordMaterializationReceipt',
    sourceFile: 'src/interactions/offboard-admission-reconciler.ts',
    callPath: 'this.deps.admissionLedger.recordMaterializationReceipt',
  },
  {
    groupId: 'api-notification-exit',
    method: 'deliver',
    sourceFile: 'src/server.ts',
    callPath: 'delivery.deliver',
  },
  {
    groupId: 'edge-resume-command',
    method: 'resumeEdgesForAccount',
    sourceFile: 'src/server.ts',
    callPath: 'edgeResumeCommand.resumeEdgesForAccount',
  },
  {
    groupId: 'facebook-scope-commands',
    method: 'importTargets',
    sourceFile: 'src/server.ts',
    callPath: 'facebookScopeCommand.importTargets',
  },
  {
    groupId: 'facebook-scope-commands',
    method: 'replaceTargetScopes',
    sourceFile: 'src/server.ts',
    callPath: 'facebookScopeCommand.replaceTargetScopes',
  },
  {
    groupId: 'publish-ui-update',
    method: 'applyPublishUiUpdate',
    sourceFile: 'src/publish-agent/publish-ui-update-producer.ts',
    callPath: 'deps.command.applyPublishUiUpdate',
  },
  {
    groupId: 'persona-generator',
    method: 'generate',
    sourceFile: 'src/config/account-persona-service.ts',
    callPath: 'this.deps.generator.generate',
  },
] as const;

const REVIEWED_BLOCKER_BINDINGS: readonly BlockerBinding[] = [
  {
    id: '4b-a1-week-mask-mirror',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'call',
        symbol: 'sessionConfigStore.weekActiveMask',
      },
    ],
  },
  {
    id: '4b-a2-automation-catalog-shared-kernel',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'identifier',
        symbol: 'SCHEDULED_AUTOMATION_CATALOG_READER',
      },
    ],
  },
  {
    id: '4b-a3-edge-presence-mirror',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/panel/panel-server.ts',
        kind: 'call',
        symbol: 'deps.edgeServer.onlineEdgeCount',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: "requireSegment(server, 'server', 'automation').resolveEdgeIdForAccount",
      },
    ],
  },
  {
    id: '4b-a4-publish-in-flight-mirror',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'call',
        symbol: 'requireSegment().getInFlightRecordIds',
      },
    ],
  },
  {
    id: '4b-a5-captcha-availability-mirror',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'call',
        symbol: 'captchaAssist.isAvailable',
      },
    ],
  },
  {
    id: '4b-a6-automation-mirror-health',
    category: '4b-mirror',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: "requireSegment(configMirrorRefresher, 'configMirrorRefresher', 'automation').health()",
      },
    ],
  },
  {
    id: '4b-b1-persona-binding-soul-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'resolvePersona',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'personaStore.bindingFor',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'getSoul',
      },
    ],
  },
  {
    id: '4b-b2-environment-gate-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'clientUserStore.automationGateForEdgeId',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'clientUserStore.slowStartSinceFor',
      },
    ],
  },
  {
    id: '4b-b3-config-freshness-runtime',
    category: '4b-mirror',
    owner: 'shared-kernel',
    consumer: 'api and automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'new',
        symbol: 'ConfigMirrorRefresher',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'mirrorVersionStore',
      },
    ],
  },
  {
    id: '4b-b4-account-identity-status-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'accountDisplayName',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'accountDisplayNameCandidates',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'accountStore',
      },
    ],
  },
  {
    id: '4b-b5-content-schedule-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'contentScheduleStore.effectiveScheduleFor',
      },
    ],
  },
  {
    id: '4b-b5-hot-lead-config-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'hotLeadConfigStore.getGateConfig',
      },
    ],
  },
  {
    id: '4b-b5-facebook-comment-config-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'facebookCommentConfigStore.effectiveConfigFor',
      },
    ],
  },
  {
    id: '4b-b5-facebook-join-config-mirror',
    category: '4b-mirror',
    owner: 'api',
    consumer: 'automation',
    closingChange: 'split-cloud-api-composition-root-4b',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'call',
        symbol: 'facebookGroupJoinAutomationStore.getForAccount',
      },
    ],
  },
  {
    id: 'feishu-operator-natural-language-delegate',
    category: 'operator-command',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: 'automation_operator_command_unavailable:delegate',
      },
    ],
  },
  {
    id: 'feishu-operator-publish-comment',
    category: 'operator-command',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: 'automation_operator_command_unavailable:publish',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: 'automation_operator_command_unavailable:comment',
      },
    ],
  },
  {
    id: 'feishu-operator-delegated-card-actions',
    category: 'operator-command',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/feishu/api-owner-composition.ts',
        kind: 'call',
        symbol: 'handleDelegatedTaskCardAction',
      },
      {
        sourceFile: 'src/feishu/api-owner-composition.ts',
        kind: 'text',
        symbol: 'automation_operator_command_unavailable',
      },
    ],
  },
  {
    id: 'feishu-operator-dispatch-start-stop',
    category: 'operator-command',
    owner: 'automation',
    consumer: 'api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'text',
        symbol: 'automation_operator_command_unavailable:dispatch',
      },
      {
        sourceFile: 'src/panel/panel-server.ts',
        kind: 'call',
        symbol: 'deps.commandActions.dispatch',
      },
    ],
  },
  {
    id: 'content-draft-refinement-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation and api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'DraftRefinementStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'new',
        symbol: 'DraftRefinementWorker',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'identifier',
        symbol: 'draftRefinementStore',
      },
    ],
  },
  {
    id: 'content-facebook-publish-media-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation and api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'FacebookPublishMediaStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'facebookPublishMediaStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'identifier',
        symbol: 'facebookPublishMediaStore',
      },
    ],
  },
  {
    id: 'content-concept-write-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'ConceptStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'conceptStore',
      },
    ],
  },
  {
    id: 'content-curated-write-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation and api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'CuratedContentStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'curatedContentStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'identifier',
        symbol: 'curatedContentStore',
      },
    ],
  },
  {
    id: 'content-role-factories',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'CONTENT_ROLE_FACTORIES',
      },
    ],
  },
  {
    id: 'content-generic-llm-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation and api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'QwenClient',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'llm',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'identifier',
        symbol: 'llm',
      },
    ],
  },
  {
    id: 'content-token-usage-authority',
    category: 'content-owner',
    owner: 'content',
    consumer: 'automation and api',
    closingChange: 'future',
    probes: [
      {
        sourceFile: 'src/server.ts',
        scope: 'segAApiFoundation',
        kind: 'new',
        symbol: 'TokenUsageStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segCAutomation',
        kind: 'identifier',
        symbol: 'tokenUsageStore',
      },
      {
        sourceFile: 'src/server.ts',
        scope: 'segDApiServing',
        kind: 'identifier',
        symbol: 'tokenUsageStore',
      },
    ],
  },
] as const;

async function sourceFile(relative: string): Promise<ts.SourceFile> {
  const absolute = resolve(REPO_ROOT, relative);
  const source = await readFile(absolute, 'utf8');
  return ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findInterfaceMethods(file: ts.SourceFile, interfaceName: string): string[] {
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName) {
      return statement.members.flatMap((member) => {
        if (!ts.isMethodSignature(member)) return [];
        const name = nameText(member.name);
        return name ? [name] : [];
      });
    }
  }
  return [];
}

function findObjectKeys(file: ts.SourceFile, constantName: string): string[] {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== constantName) continue;
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) {
        initializer = initializer.expression;
      }
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) return [];
      return initializer.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          return [];
        }
        const name = nameText(property.name);
        return name ? [name] : [];
      });
    }
  }
  return [];
}

function findClassMethods(file: ts.SourceFile, className: string): string[] {
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    return statement.members.flatMap((member) => {
      if (!ts.isMethodDeclaration(member)) return [];
      if (
        member.modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword
            || modifier.kind === ts.SyntaxKind.ProtectedKeyword
            || modifier.kind === ts.SyntaxKind.StaticKeyword,
        )
      ) {
        return [];
      }
      const name = nameText(member.name);
      return name ? [name] : [];
    });
  }
  return [];
}

function findFunction(file: ts.SourceFile, functionName: string): ts.FunctionDeclaration | null {
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === functionName) return statement;
  }
  return null;
}

function routeKeysReferenced(
  file: ts.SourceFile,
  functionName: string,
  routesConstant: string,
): string[] {
  const fn = findFunction(file, functionName);
  if (!fn) return [];
  const keys: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === routesConstant
    ) {
      keys.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return [...new Set(keys)];
}

function hasCall(file: ts.SourceFile, functionName: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === functionName
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function hasNew(file: ts.SourceFile, className: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === className
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function callChain(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expression)) {
    const left = callChain(expression.expression);
    return left ? `${left}.${expression.name.text}` : null;
  }
  if (ts.isCallExpression(expression)) {
    const called = callChain(expression.expression);
    return called ? `${called}()` : null;
  }
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    return callChain(expression.expression);
  }
  return null;
}

function collectCallChains(file: ts.SourceFile): Set<string> {
  const calls = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = callChain(node.expression);
      if (chain) calls.add(chain);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function consumerCallSite(
  file: ts.SourceFile,
  binding: ProductionConsumerBinding,
): string | null {
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && callChain(node.expression) === binding.callPath) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found ? `${binding.sourceFile}#call:${binding.callPath}` : null;
}

export async function deriveSurface(): Promise<{
  groups: DerivedSurfaceGroup[];
  alternates: DerivedAlternate[];
}> {
  const kernel = await sourceFile('src/kernel/api-direct-port.ts');
  const server = await sourceFile('src/server.ts');
  const transportByFile = new Map<string, ts.SourceFile>();
  const consumerSourceByFile = new Map<string, ts.SourceFile>();
  const consumerSitesByGroupMethod = new Map<string, string[]>();
  for (const binding of PRODUCTION_CONSUMER_BINDINGS) {
    let consumerSource = consumerSourceByFile.get(binding.sourceFile);
    if (!consumerSource) {
      consumerSource = await sourceFile(binding.sourceFile);
      consumerSourceByFile.set(binding.sourceFile, consumerSource);
    }
    const evidence = consumerCallSite(consumerSource, binding);
    if (!evidence) continue;
    const key = `${binding.groupId}:${binding.method}`;
    const existing = consumerSitesByGroupMethod.get(key) ?? [];
    existing.push(evidence);
    consumerSitesByGroupMethod.set(key, existing);
  }
  const groups: DerivedSurfaceGroup[] = [];
  for (const binding of SURFACE_BINDINGS) {
    let transport = transportByFile.get(binding.transportFile);
    if (!transport) {
      transport = await sourceFile(binding.transportFile);
      transportByFile.set(binding.transportFile, transport);
    }
    groups.push({
      id: binding.id,
      direction: binding.direction,
      methods: findInterfaceMethods(kernel, binding.interfaceName),
      routeMethods: findObjectKeys(transport, binding.routesConstant),
      registeredRouteMethods: routeKeysReferenced(
        transport,
        binding.registerFunction,
        binding.routesConstant,
      ),
      clientMethods: findClassMethods(transport, binding.clientClass),
      productionConsumerMethods: findInterfaceMethods(kernel, binding.interfaceName)
        .filter((method) =>
          (consumerSitesByGroupMethod.get(`${binding.id}:${method}`)?.length ?? 0) > 0),
      productionConsumerCallSites: Object.fromEntries(
        findInterfaceMethods(kernel, binding.interfaceName)
          .flatMap((method) => {
            const evidence = consumerSitesByGroupMethod.get(`${binding.id}:${method}`) ?? [];
            return evidence.length > 0 ? [[method, evidence]] : [];
          }),
      ),
      productionRegistration: hasCall(server, binding.registerFunction),
      productionClient: hasNew(server, binding.clientClass),
    });
  }

  const calls = collectCallChains(server);
  const pendingScan = calls.has('publishApprovalClient.listPendingDispatch')
    ? 'publishApprovalClient.listPendingDispatch'
    : calls.has('automationPublishLog.listPendingApprovalIds')
      ? 'automationPublishLog.listPendingApprovalIds'
      : null;
  const remotePreview = calls.has('automationPublishLog.pendingPublishPreviewForAccount');
  const ownerLocalPreview = calls.has('publishLogStore.pendingPublishPreviewForAccount');
  const uiProjection = [...calls].some((call) => call.endsWith('.applyPublishUiUpdate'));
  const preview = remotePreview
    ? 'automationPublishLog.pendingPublishPreviewForAccount'
    : ownerLocalPreview && uiProjection
      ? 'publishLogStore.pendingPublishPreviewForAccount+publishUiUpdateCommand.applyPublishUiUpdate'
      : null;

  return {
    groups,
    alternates: [
      { id: 'pending-publish-scan', selected: pendingScan },
      { id: 'publish-preview-projection', selected: preview },
    ],
  };
}

function functionBody(file: ts.SourceFile, functionName: string): ts.Block | null {
  return findFunction(file, functionName)?.body ?? null;
}

function containsIdentifier(root: ts.Node | null, identifier: string): boolean {
  if (!root) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === identifier) found = true;
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function containsNew(root: ts.Node | null, className: string): boolean {
  if (!root) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === className
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function containsCall(root: ts.Node | null, callPath: string): boolean {
  if (!root) return false;
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && callChain(node.expression) === callPath) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function normalizeImportedSource(moduleName: string): string | null {
  if (!moduleName.startsWith('./')) return null;
  const relative = moduleName.replace(/^\.\//, 'src/').replace(/\.js$/, '.ts');
  return relative;
}

function importedOwners(
  server: ts.SourceFile,
  ownership: readonly OwnershipEntry[],
): Map<string, { source: string; owner: string }> {
  const ownerBySource = new Map(ownership.map((entry) => [entry.path, entry.layer]));
  const result = new Map<string, { source: string; owner: string }>();
  for (const statement of server.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const source = normalizeImportedSource(statement.moduleSpecifier.text);
    const owner = source ? ownerBySource.get(source) : undefined;
    if (!source || !owner) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) result.set(clause.name.text, { source, owner });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        result.set(element.name.text, { source, owner });
      }
    }
  }
  return result;
}

function variableNameFor(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isVariableDeclaration(current)) return nameText(current.name) ?? '<binding>';
    current = current.parent;
  }
  return '<expression>';
}

function ownerPools(root: ts.Node | null): string[] {
  if (!root) return [];
  const evidence: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'pg'
      && node.expression.name.text === 'Pool'
    ) {
      let owner: string | null = null;
      function findOwner(candidate: ts.Node): void {
        if (
          ts.isCallExpression(candidate)
          && ts.isIdentifier(candidate.expression)
          && candidate.expression.text === 'resolveOwnerPgConfig'
          && candidate.arguments.length > 0
          && ts.isStringLiteral(candidate.arguments[0]!)
        ) {
          owner = candidate.arguments[0]!.text;
        }
        ts.forEachChild(candidate, findOwner);
      }
      findOwner(node);
      if (owner) evidence.push(`${variableNameFor(node)}:${owner}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return evidence.sort();
}

function isApiOwnerModeOnly(node: ts.Node, root: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (ts.isIfStatement(current)) {
      const condition = current.expression.getText();
      const isThenBranch = current.thenStatement.pos <= node.pos
        && node.end <= current.thenStatement.end;
      if (
        isThenBranch
        && (
          /(?:serviceMode|serviceModeFromEnv\(\)|approvalOwnerMode)\s*===\s*['"]api['"]/.test(condition)
          || condition.includes('ownsPublishApprovalAuthorityForMode(')
        )
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function ownerStoreConstructions(
  root: ts.Node | null,
  imports: ReadonlyMap<string, { source: string; owner: string }>,
): string[] {
  if (!root) return [];
  const scope = root;
  const evidence: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = imports.get(node.expression.text);
      const argumentsUseOwnerPool = node.arguments?.some((argument) =>
        ['apiPool', 'automationPool', 'contentPool', 'tokenUsagePool', 'configMirrorPool']
          .some((pool) => containsIdentifier(argument, pool))) ?? false;
      if (
        imported
        && ['api', 'automation', 'content'].includes(imported.owner)
        && argumentsUseOwnerPool
        && !isApiOwnerModeOnly(node, scope)
      ) {
        evidence.push(`${node.expression.text}:${imported.owner}:${imported.source}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return [...new Set(evidence)].sort();
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function probeEvidence(
  file: ts.SourceFile,
  probe: EvidenceProbe,
): string | null {
  const root = probe.scope ? functionBody(file, probe.scope) : file;
  if (!root) return null;
  const present =
    probe.kind === 'call'
      ? containsCall(root, probe.symbol)
      : probe.kind === 'new'
        ? containsNew(root, probe.symbol)
        : probe.kind === 'identifier'
          ? containsIdentifier(root, probe.symbol)
          : root.getText(file).includes(probe.symbol);
  if (!present) return null;
  const scope = probe.scope ? `${probe.scope}:` : '';
  return `${probe.sourceFile}#${scope}${probe.kind}:${probe.symbol}`;
}

export async function deriveIndependentRootBlockers(): Promise<DerivedBlocker[]> {
  const [server, ownershipRaw] = await Promise.all([
    sourceFile('src/server.ts'),
    readFile(resolve(REPO_ROOT, 'boundaries/module-ownership.json'), 'utf8'),
  ]);
  const ownership = JSON.parse(ownershipRaw) as OwnershipEntry[];
  const segA = functionBody(server, 'segAApiFoundation');
  const imports = importedOwners(server, ownership);
  const sourceByFile = new Map<string, ts.SourceFile>([['src/server.ts', server]]);
  const reviewed: DerivedBlocker[] = [];
  for (const binding of REVIEWED_BLOCKER_BINDINGS) {
    const evidence: string[] = [];
    for (const probe of binding.probes) {
      let file = sourceByFile.get(probe.sourceFile);
      if (!file) {
        file = await sourceFile(probe.sourceFile);
        sourceByFile.set(probe.sourceFile, file);
      }
      const item = probeEvidence(file, probe);
      if (item) evidence.push(item);
    }
    if (evidence.length > 0) {
      reviewed.push({
        id: binding.id,
        category: binding.category,
        owner: binding.owner,
        consumer: binding.consumer,
        closingChange: binding.closingChange,
        evidence,
      });
    }
  }

  const pools = ownerPools(segA).map((evidence): DerivedBlocker => {
    const [poolName, owner] = evidence.split(':');
    return {
      id: `seg-a-foreign-pool-${kebabCase(poolName ?? evidence)}`,
      category: 'composition-root',
      owner: owner ?? 'unknown',
      consumer: 'shared segA composition root',
      closingChange: 'future',
      evidence: [`src/server.ts#segAApiFoundation:pool:${evidence}`],
    };
  });
  const apiOwnerStores = ownerStoreConstructions(segA, imports)
    .flatMap((evidence): DerivedBlocker[] => {
      const [className, owner, source] = evidence.split(':');
      if (!className || owner !== 'api' || !source) return [];
      return [{
        id: `seg-a-api-owner-${kebabCase(className)}`,
        category: 'composition-root',
        owner,
        consumer: 'automation and content roots through shared segA',
        closingChange: 'future',
        evidence: [
          `src/server.ts#segAApiFoundation:new:${className}:${owner}:${source}`,
        ],
      }];
    });
  return [...reviewed, ...pools, ...apiOwnerStores];
}

export function assertNoIndependentRootBlockers(
  blockers: readonly DerivedBlocker[],
): void {
  if (blockers.length === 0) return;
  const detail = blockers
    .map((blocker) => {
      const visible = blocker.evidence.slice(0, 5);
      const remainder = blocker.evidence.length - visible.length;
      return `${blocker.id} (${blocker.evidence.length}): ${visible.join(', ')}`
        + (remainder > 0 ? `, ... +${remainder}` : '');
    })
    .join('\n');
  throw new Error(
    `independent composition roots remain blocked (${blockers.length} ledger entries)\n${detail}`,
  );
}

async function runCli(argv: readonly string[]): Promise<void> {
  if (
    argv.length !== 1
    || !['--report', '--refresh-ledger', '--require-empty'].includes(argv[0]!)
  ) {
    throw new Error(
      'usage: composition-root-4a-census.ts <--report|--refresh-ledger|--require-empty>',
    );
  }
  const [surface, blockers] = await Promise.all([
    deriveSurface(),
    deriveIndependentRootBlockers(),
  ]);
  if (argv[0] === '--report') {
    const methods = surface.groups.reduce((sum, group) => sum + group.methods.length, 0);
    const consumed = surface.groups.reduce(
      (sum, group) => sum + group.productionConsumerMethods.length,
      0,
    );
    console.log(
      `composition-root 4a census groups=${surface.groups.length}`
      + ` methodSlots=${methods} productionConsumers=${consumed}`
      + ` approvedAlternates=${surface.alternates.filter((item) => item.selected).length}`
      + ` independentRootBlockers=${blockers.length}`,
    );
    return;
  }
  if (argv[0] === '--refresh-ledger') {
    const byCategory = Object.fromEntries(
      ['4b-mirror', 'operator-command', 'content-owner', 'composition-root']
        .map((category) => [
          category,
          blockers.filter((blocker) => blocker.category === category).length,
        ]),
    );
    const ledger = {
      schemaVersion: 2,
      change: 'split-cloud-api-composition-root-4a',
      claimBlocked: blockers.length > 0,
      claim:
        'api, automation, and content are independently bootable without foreign owner pools, stores, or synchronous in-process dependencies',
      summary: {
        total: blockers.length,
        byCategory,
      },
      blockers,
    };
    await writeFile(
      resolve(REPO_ROOT, 'boundaries/composition-root-independent-blockers.json'),
      `${JSON.stringify(ledger, null, 2)}\n`,
      'utf8',
    );
    console.log(`refreshed independent composition-root blocker ledger (${blockers.length})`);
    return;
  }
  assertNoIndependentRootBlockers(blockers);
  console.log('independent composition-root blocker ledger is empty');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
