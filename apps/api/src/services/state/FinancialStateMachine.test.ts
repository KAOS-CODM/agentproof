import { describe, it, expect } from 'vitest';
import { FinancialStateMachine } from './FinancialStateMachine.js';

describe('FinancialStateMachine', () => {
  it('starts in INTENT_CREATED state', () => {
    const sm = new FinancialStateMachine();
    expect(sm.getState()).toBe('INTENT_CREATED');
  });

  it('allows valid transition INTENT_CREATED → PRODUCT_SELECTED', () => {
    const sm = new FinancialStateMachine();
    sm.transitionTo('PRODUCT_SELECTED');
    expect(sm.getState()).toBe('PRODUCT_SELECTED');
  });

  it('allows valid transition PRODUCT_SELECTED → PAYMENT_PENDING', () => {
    const sm = new FinancialStateMachine('PRODUCT_SELECTED');
    sm.transitionTo('PAYMENT_PENDING');
    expect(sm.getState()).toBe('PAYMENT_PENDING');
  });

  it('allows valid transition PAYMENT_PENDING → PAYMENT_COMPLETED', () => {
    const sm = new FinancialStateMachine('PAYMENT_PENDING');
    sm.transitionTo('PAYMENT_COMPLETED');
    expect(sm.getState()).toBe('PAYMENT_COMPLETED');
  });

  it('allows valid transition PAYMENT_COMPLETED → FULFILLMENT', () => {
    const sm = new FinancialStateMachine('PAYMENT_COMPLETED');
    sm.transitionTo('FULFILLMENT');
    expect(sm.getState()).toBe('FULFILLMENT');
  });

  it('allows valid transition FULFILLMENT → DELIVERED', () => {
    const sm = new FinancialStateMachine('FULFILLMENT');
    sm.transitionTo('DELIVERED');
    expect(sm.getState()).toBe('DELIVERED');
  });

  it('allows valid transition DELIVERED → DISPUTE_OPENED', () => {
    const sm = new FinancialStateMachine('DELIVERED');
    sm.transitionTo('DISPUTE_OPENED');
    expect(sm.getState()).toBe('DISPUTE_OPENED');
  });

  it('allows valid transition DISPUTE_OPENED → EVIDENCE_REVIEW', () => {
    const sm = new FinancialStateMachine('DISPUTE_OPENED');
    sm.transitionTo('EVIDENCE_REVIEW');
    expect(sm.getState()).toBe('EVIDENCE_REVIEW');
  });

  it('allows valid transition EVIDENCE_REVIEW → RESOLVED', () => {
    const sm = new FinancialStateMachine('EVIDENCE_REVIEW');
    sm.transitionTo('RESOLVED');
    expect(sm.getState()).toBe('RESOLVED');
  });

  it('rejects invalid transition INTENT_CREATED → PAYMENT_COMPLETED', () => {
    const sm = new FinancialStateMachine();
    expect(() => sm.transitionTo('PAYMENT_COMPLETED')).toThrow(
      'Invalid financial state transition',
    );
  });

  it('rejects invalid transition INTENT_CREATED → RESOLVED', () => {
    const sm = new FinancialStateMachine();
    expect(() => sm.transitionTo('RESOLVED')).toThrow(
      'Invalid financial state transition',
    );
  });

  it('rejects invalid transition RESOLVED → INTENT_CREATED', () => {
    const sm = new FinancialStateMachine('RESOLVED');
    expect(() => sm.transitionTo('INTENT_CREATED')).toThrow(
      'Invalid financial state transition',
    );
  });

  it('rejects invalid transition PAYMENT_COMPLETED → INTENT_CREATED', () => {
    const sm = new FinancialStateMachine('PAYMENT_COMPLETED');
    expect(() => sm.transitionTo('INTENT_CREATED')).toThrow(
      'Invalid financial state transition',
    );
  });

  it('canTransitionTo returns true for valid transitions', () => {
    const sm = new FinancialStateMachine('INTENT_CREATED');
    expect(sm.canTransitionTo('PRODUCT_SELECTED')).toBe(true);
  });

  it('canTransitionTo returns false for invalid transitions', () => {
    const sm = new FinancialStateMachine('INTENT_CREATED');
    expect(sm.canTransitionTo('PAYMENT_COMPLETED')).toBe(false);
  });

  it('getValidTransitions returns correct options', () => {
    const sm = new FinancialStateMachine('PAYMENT_COMPLETED');
    const valid = sm.getValidTransitions();
    expect(valid).toContain('FULFILLMENT');
    expect(valid).toContain('DISPUTE_OPENED');
    expect(valid).not.toContain('INTENT_CREATED');
  });

  it('allows PAYMENT_COMPLETED → DISPUTE_OPENED', () => {
    const sm = new FinancialStateMachine('PAYMENT_COMPLETED');
    sm.transitionTo('DISPUTE_OPENED');
    expect(sm.getState()).toBe('DISPUTE_OPENED');
  });
});
