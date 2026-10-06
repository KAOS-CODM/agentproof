import { describe, it, expect } from 'vitest';
import { AuthorityStateMachine } from './AuthorityStateMachine.js';

describe('AuthorityStateMachine', () => {
  it('initializes all actions as NOT_REQUIRED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    const states = asm.getAllStates();
    expect(states.PURCHASE).toBe('NOT_REQUIRED');
    expect(states.REFUND).toBe('NOT_REQUIRED');
    expect(states.DISPUTE_RESPONSE).toBe('NOT_REQUIRED');
    expect(states.CANCEL_ORDER).toBe('NOT_REQUIRED');
  });

  it('allows independent action states', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('PURCHASE', 'PENDING');
    asm.transitionTo('PURCHASE', 'APPROVED');
    asm.transitionTo('PURCHASE', 'EXECUTED');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');

    expect(asm.getStatus('PURCHASE')).toBe('EXECUTED');
    expect(asm.getStatus('REFUND')).toBe('APPROVAL_REQUIRED');
    expect(asm.getStatus('DISPUTE_RESPONSE')).toBe('NOT_REQUIRED');
  });

  it('allows NOT_REQUIRED → PENDING', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    expect(asm.getStatus('REFUND')).toBe('PENDING');
  });

  it('allows PENDING → APPROVAL_REQUIRED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');
    expect(asm.getStatus('REFUND')).toBe('APPROVAL_REQUIRED');
  });

  it('allows APPROVAL_REQUIRED → APPROVED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');
    asm.transitionTo('REFUND', 'APPROVED');
    expect(asm.getStatus('REFUND')).toBe('APPROVED');
  });

  it('allows APPROVED → EXECUTED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');
    asm.transitionTo('REFUND', 'APPROVED');
    asm.transitionTo('REFUND', 'EXECUTED');
    expect(asm.getStatus('REFUND')).toBe('EXECUTED');
  });

  it('allows APPROVAL_REQUIRED → DENIED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');
    asm.transitionTo('REFUND', 'DENIED');
    expect(asm.getStatus('REFUND')).toBe('DENIED');
  });

  it('rejects invalid transition NOT_REQUIRED → APPROVED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    expect(() => asm.transitionTo('REFUND', 'APPROVED')).toThrow(
      'Invalid authority transition',
    );
  });

  it('rejects invalid transition EXECUTED → PENDING', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('PURCHASE', 'PENDING');
    asm.transitionTo('PURCHASE', 'APPROVED');
    asm.transitionTo('PURCHASE', 'EXECUTED');
    expect(() => asm.transitionTo('PURCHASE', 'PENDING')).toThrow(
      'Invalid authority transition',
    );
  });

  it('rejects invalid transition DENIED → APPROVED', () => {
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'DENIED');
    expect(() => asm.transitionTo('REFUND', 'APPROVED')).toThrow(
      'Invalid authority transition',
    );
  });

  it('maintains independent states for different actions', () => {
    const asm = new AuthorityStateMachine('tx-1');

    // Purchase flow
    asm.transitionTo('PURCHASE', 'PENDING');
    asm.transitionTo('PURCHASE', 'APPROVED');
    asm.transitionTo('PURCHASE', 'EXECUTED');

    // Refund flow (independent)
    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');

    expect(asm.getStatus('PURCHASE')).toBe('EXECUTED');
    expect(asm.getStatus('REFUND')).toBe('APPROVAL_REQUIRED');
    expect(asm.getStatus('DISPUTE_RESPONSE')).toBe('NOT_REQUIRED');
    expect(asm.getStatus('CANCEL_ORDER')).toBe('NOT_REQUIRED');
  });

  it('coexists with financial state PAYMENT_COMPLETED', () => {
    // This test documents that authority state is independent of financial state.
    // Financial state: PAYMENT_COMPLETED
    // Authority state for REFUND: APPROVAL_REQUIRED
    // These are not contradictory.
    const asm = new AuthorityStateMachine('tx-1');
    asm.transitionTo('PURCHASE', 'PENDING');
    asm.transitionTo('PURCHASE', 'APPROVED');
    asm.transitionTo('PURCHASE', 'EXECUTED');

    asm.transitionTo('REFUND', 'PENDING');
    asm.transitionTo('REFUND', 'APPROVAL_REQUIRED');

    // Purchase is done, refund needs approval
    expect(asm.getStatus('PURCHASE')).toBe('EXECUTED');
    expect(asm.getStatus('REFUND')).toBe('APPROVAL_REQUIRED');
  });
});
