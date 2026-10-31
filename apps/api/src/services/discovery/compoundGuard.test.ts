import { describe, it, expect } from 'vitest';
import { detectCompoundIntent } from './compoundGuard.js';

describe('detectCompoundIntent', () => {
  it('detects "shoes and watch" as compound', () => {
    expect(detectCompoundIntent('shoes and watch')).toBe(true);
  });

  it('detects "i need shoes and watch, not less than 100 dollars" as compound', () => {
    expect(detectCompoundIntent('i need shoes and watch, not less than 100 dollars')).toBe(true);
  });

  it('detects "running shoes and a watch" as compound', () => {
    expect(detectCompoundIntent('running shoes and a watch')).toBe(true);
  });

  it('does NOT flag "running shoes under $150" as compound', () => {
    expect(detectCompoundIntent('running shoes under $150')).toBe(false);
  });

  it('does NOT flag "get me a watch at least $100" as compound', () => {
    expect(detectCompoundIntent('get me a watch at least $100')).toBe(false);
  });

  it('does NOT flag "new and waterproof running shoes" as compound', () => {
    expect(detectCompoundIntent('new and waterproof running shoes')).toBe(false);
  });

  it('does NOT flag single-word requests as compound', () => {
    expect(detectCompoundIntent('shoes')).toBe(false);
    expect(detectCompoundIntent('watch')).toBe(false);
  });

  it('does NOT flag "shoes or watch" as compound (no "and")', () => {
    expect(detectCompoundIntent('shoes or watch')).toBe(false);
  });

  it('detects "buy me shoes and a watch" as compound', () => {
    expect(detectCompoundIntent('buy me shoes and a watch')).toBe(true);
  });
});
