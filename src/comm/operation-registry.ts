import type { MessageType } from './protocol.js';

export type AutomationOperationClass =
  | 'automation_control'
  | 'platform_api_automation'
  | 'browser_lifecycle'
  | 'page_automation';

export interface AutomationOperationDescriptor {
  category: AutomationOperationClass;
  transport: 'automation_ws';
  identity: 'none' | 'bound_account' | 'page_account';
  browser: 'forbidden' | 'on_demand' | 'required';
}

const automationControl = (identity: AutomationOperationDescriptor['identity'] = 'bound_account'): AutomationOperationDescriptor => ({
  category: 'automation_control', transport: 'automation_ws', identity, browser: 'forbidden',
});
const platformApiAutomation = (): AutomationOperationDescriptor => ({
  category: 'platform_api_automation', transport: 'automation_ws', identity: 'bound_account', browser: 'forbidden',
});
const browserLifecycle = (): AutomationOperationDescriptor => ({
  category: 'browser_lifecycle', transport: 'automation_ws', identity: 'bound_account', browser: 'on_demand',
});
const pageAutomation = (): AutomationOperationDescriptor => ({
  category: 'page_automation', transport: 'automation_ws', identity: 'page_account', browser: 'required',
});

/**
 * Cloud -> Edge active-operation registry. The WebSocket is the automation channel, not the
 * customer's general data plane. Any newly pushed operation must declare identity and browser needs here.
 */
export const AUTOMATION_OPERATION_REGISTRY = {
  'ui.snapshot': automationControl(),
  'pacing.update': automationControl(),
  'interaction.sync.ack': automationControl(),
  'interaction.reply.result.ack': automationControl(),
  'interaction.offboard.ack': automationControl(),
  'interaction.runtime.controls': automationControl(),
  ping: automationControl('none'),
  pong: automationControl('none'),

  'interaction.sync.request': platformApiAutomation(),
  'interaction.reply.send': platformApiAutomation(),
  'interaction.reply.reconcile': platformApiAutomation(),
  'interaction.offboard.command': platformApiAutomation(),

  'interaction.auth.reopen': browserLifecycle(),
  'interaction.browser.control': browserLifecycle(),

  'plan.response': pageAutomation(),
  'session.end': pageAutomation(),
  'browse.next': pageAutomation(),
  'browse.scroll': pageAutomation(),
  'note.open': pageAutomation(),
  'note.close': pageAutomation(),
  'search.execute': pageAutomation(),
  'page.scroll': pageAutomation(),
  'feed.refresh': pageAutomation(),
  'interaction.like': pageAutomation(),
  'interaction.collect': pageAutomation(),
  'interaction.follow': pageAutomation(),
  'interaction.comment': pageAutomation(),
  'interaction.like_comment': pageAutomation(),
  'group.join': pageAutomation(),
  'navigation.back': pageAutomation(),
  'note.browse_images': pageAutomation(),
  'note.scroll_comments': pageAutomation(),
  'profile.open': pageAutomation(),
  'notification.open': pageAutomation(),
  'notification.browse_comments': pageAutomation(),
  'notification.browse_likes': pageAutomation(),
  'notification.browse_follows': pageAutomation(),
  'notification.back_home': pageAutomation(),
  'publish.request': pageAutomation(),
  'publish.command': pageAutomation(),
  'edge.task.acquire': pageAutomation(),
  'edge.task.release': pageAutomation(),
  'captcha.assist.capture': pageAutomation(),
  'captcha.assist.click': pageAutomation(),
} as const satisfies Partial<Record<MessageType, AutomationOperationDescriptor>>;

export function automationOperationDescriptorFor(type: MessageType): AutomationOperationDescriptor | null {
  return (AUTOMATION_OPERATION_REGISTRY as Partial<Record<MessageType, AutomationOperationDescriptor>>)[type] ?? null;
}
