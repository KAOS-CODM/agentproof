import type { FinancialState } from '@agentproof/shared';

const VALID_TRANSITIONS: Record<FinancialState, FinancialState[]> = {
  INTENT_CREATED: ['PRODUCT_SELECTED'],
  PRODUCT_SELECTED: ['PAYMENT_PENDING'],
  PAYMENT_PENDING: ['PAYMENT_COMPLETED'],
  PAYMENT_COMPLETED: ['FULFILLMENT', 'DISPUTE_OPENED'],
  FULFILLMENT: ['DELIVERED', 'DISPUTE_OPENED'],
  DELIVERED: ['DISPUTE_OPENED'],
  DISPUTE_OPENED: ['EVIDENCE_REVIEW'],
  EVIDENCE_REVIEW: ['RESOLVED'],
  RESOLVED: [],
};

export class FinancialStateMachine {
  private currentState: FinancialState;

  constructor(initialState: FinancialState = 'INTENT_CREATED') {
    this.currentState = initialState;
  }

  getState(): FinancialState {
    return this.currentState;
  }

  canTransitionTo(target: FinancialState): boolean {
    return VALID_TRANSITIONS[this.currentState].includes(target);
  }

  transitionTo(target: FinancialState): FinancialState {
    if (!this.canTransitionTo(target)) {
      throw new Error(
        `Invalid financial state transition: ${this.currentState} → ${target}`,
      );
    }
    this.currentState = target;
    return this.currentState;
  }

  getValidTransitions(): FinancialState[] {
    return VALID_TRANSITIONS[this.currentState];
  }
}
