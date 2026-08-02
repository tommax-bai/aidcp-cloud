/**
 * 4a transport export surface.
 *
 * Capability-specific route tables, registrars, and clients remain in their
 * owner-direction modules. This barrel is only a composition-root import point
 * plus a mechanical route inventory; it does not create a mega-client.
 */
export * from './api-direct-http-common.js';
export * from './api-account-authority-http.js';
export * from './api-publish-interaction-http.js';
export * from './api-aux-authority-http.js';
export * from './paired-command-http.js';

import { ACCOUNT_OWNERSHIP_ROUTES, ACCOUNT_ROSTER_ROUTES, ACCOUNT_RUNTIME_ROUTES } from './api-account-authority-http.js';
import {
  ACCOUNT_PERSONA_ROUTES,
  AUTOMATION_CONFIG_COMMANDS_ROUTES,
  COMMENT_APPROVAL_POLICY_ROUTES,
  SCHEDULE_FEEDBACK_ROUTES,
  ENVIRONMENT_HANDSHAKE_ROUTES,
  FIRST_POST_PROGRESS_ROUTES,
  NOTIFICATION_CONTACTS_ROUTES,
  OFFBOARD_ADMISSION_LEDGER_ROUTES,
  STRUCTURED_NOTIFICATION_ROUTES,
} from './api-aux-authority-http.js';
import {
  AUTOMATION_PUBLISH_LOG_ROUTES,
  EDGE_PUBLISH_COMMAND_ROUTES,
  INTERACTION_API_WRITES_ROUTES,
  INTERACTION_AUTH_ROUTES,
  REPLY_CONFIG_RESOLVER_ROUTES,
} from './api-publish-interaction-http.js';
import {
  EDGE_RESUME_COMMAND_ROUTES,
  FACEBOOK_SCOPE_COMMAND_ROUTES,
  PERSONA_GENERATOR_COMMAND_ROUTES,
  PUBLISH_UI_UPDATE_COMMAND_ROUTES,
} from './paired-command-http.js';

export const API_DIRECT_ROUTE_INVENTORY = {
  accountRoster: ACCOUNT_ROSTER_ROUTES,
  accountOwnership: ACCOUNT_OWNERSHIP_ROUTES,
  accountRuntime: ACCOUNT_RUNTIME_ROUTES,
  publishLog: AUTOMATION_PUBLISH_LOG_ROUTES,
  edgePublish: EDGE_PUBLISH_COMMAND_ROUTES,
  interactionAuth: INTERACTION_AUTH_ROUTES,
  interactionApiWrites: INTERACTION_API_WRITES_ROUTES,
  replyConfig: REPLY_CONFIG_RESOLVER_ROUTES,
  accountPersona: ACCOUNT_PERSONA_ROUTES,
  environmentHandshake: ENVIRONMENT_HANDSHAKE_ROUTES,
  commentApprovalPolicy: COMMENT_APPROVAL_POLICY_ROUTES,
  scheduleFeedback: SCHEDULE_FEEDBACK_ROUTES,
  notificationContacts: NOTIFICATION_CONTACTS_ROUTES,
  firstPostProgress: FIRST_POST_PROGRESS_ROUTES,
  automationConfigCommands: AUTOMATION_CONFIG_COMMANDS_ROUTES,
  offboardAdmissionLedger: OFFBOARD_ADMISSION_LEDGER_ROUTES,
  notificationDelivery: STRUCTURED_NOTIFICATION_ROUTES,
  edgeResumeCommand: EDGE_RESUME_COMMAND_ROUTES,
  facebookScopeCommands: FACEBOOK_SCOPE_COMMAND_ROUTES,
  publishUiUpdateCommand: PUBLISH_UI_UPDATE_COMMAND_ROUTES,
  personaGenerator: PERSONA_GENERATOR_COMMAND_ROUTES,
} as const;
