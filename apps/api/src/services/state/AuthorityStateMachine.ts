import type { ActionType, AuthorityStatus } from '@agentproof/shared';

const VALID_TRANSITIONS: Record<AuthorityStatus, AuthorityStatus[]> = {
  NOT_REQUIRED: ['PENDING'],
  PENDING: ['APPROVAL_REQUIRED', 'APPROVED', 'DENIED'],
  APPROVAL_REQUIRED: ['APPROVED', 'DENIED'],
  APPROVED: ['EXECUTED'],
  DENIED: [],
  EXECUTED: [],
};

export class AuthorityStateMachine {
  private states: Map<ActionType, AuthorityStatus> = new Map();

  constructor(transactionId: string) {
    // Initialize all actions as NOT_REQUIRED
    const actions: ActionType[] = ['PURCHASE', 'REFUND', 'DISPUTE_RESPONSE', 'CANCEL_ORDER'];
    for (const action of actions) {
      this.states.set(action, 'NOT_REQUIRED');
    }
  }

  getStatus(action: ActionType): AuthorityStatus {
    return this.states.get(action) ?? 'NOT_REQUIRED';
  }

  canTransitionTo(action: ActionType, target: AuthorityStatus): boolean {
    const current = this.getStatus(action);
    return VALID_TRANSITIONS[current].includes(target);
  }

  transitionTo(action: ActionType, target: AuthorityStatus): AuthorityStatus {
    if (!this.canTransitionTo(action, target)) {
      throw new Error(
        `Invalid authority transition for ${action}: ${this.getStatus(action)} → ${target}`,
      );
    }
    this.states.set(action, target);
    return target;
  }

  getAllStates(): Record<ActionType, AuthorityStatus> {
    const result: Record<ActionType, AuthorityStatus> = {} as Record<ActionType, AuthorityStatus>;
    for (const [action, status] of this.states) {
      result[action] = status;
    }
    return result;
  }
}
