import type { DelegatedTask } from './types.js';

export function delegatedTaskNotificationFingerprint(task: DelegatedTask): string {
  return JSON.stringify({
    status: task.status,
    currentStep: task.status === 'waiting_approval' ? 'waiting_approval' : task.currentStep,
    progress: task.progress,
    terminalOutcome: task.terminalOutcome,
    pauseRequested: task.pauseRequested,
    cancelRequested: task.cancelRequested,
  });
}

export class DelegatedTaskNotificationGate {
  private readonly sent = new Map<string, string>();

  shouldSend(task: DelegatedTask): boolean {
    return this.sent.get(task.id) !== delegatedTaskNotificationFingerprint(task);
  }

  markSent(task: DelegatedTask): void {
    this.sent.set(task.id, delegatedTaskNotificationFingerprint(task));
  }
}
