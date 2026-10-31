import { describe, it, expect } from 'vitest';
import {
  extractTransportDiagnostic,
  formatTransportDiagnostic,
} from './transportDiagnostics.js';

function fetchFailure(cause?: Record<string, unknown>): TypeError {
  const err = new TypeError('fetch failed');
  if (cause) (err as { cause?: unknown }).cause = cause;
  return err;
}

describe('extractTransportDiagnostic', () => {
  it('extracts name, cause.code, cause.syscall and cause.hostname', () => {
    const diagnostic = extractTransportDiagnostic(
      fetchFailure({ code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api-m.sandbox.paypal.com' }),
    );
    expect(diagnostic).toEqual({
      name: 'TypeError',
      code: 'EAI_AGAIN',
      syscall: 'getaddrinfo',
      hostname: 'api-m.sandbox.paypal.com',
    });
  });

  it('returns name with nulls when there is no cause', () => {
    expect(extractTransportDiagnostic(fetchFailure())).toEqual({
      name: 'TypeError',
      code: null,
      syscall: null,
      hostname: null,
    });
  });

  it('ignores non-string cause fields', () => {
    const err = fetchFailure({ code: 42, syscall: {}, hostname: [] });
    expect(extractTransportDiagnostic(err)).toEqual({
      name: 'TypeError',
      code: null,
      syscall: null,
      hostname: null,
    });
  });

  it('returns null for non-Error values', () => {
    expect(extractTransportDiagnostic('fetch failed')).toBeNull();
    expect(extractTransportDiagnostic(undefined)).toBeNull();
    expect(extractTransportDiagnostic({ name: 'TypeError' })).toBeNull();
  });
});

describe('formatTransportDiagnostic', () => {
  it('formats all available fields as a bracketed suffix', () => {
    const out = formatTransportDiagnostic(
      fetchFailure({ code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'openrouter.ai' }),
    );
    expect(out).toBe(' [name=TypeError code=ENOTFOUND syscall=getaddrinfo hostname=openrouter.ai]');
  });

  it('formats with only name when there is no cause.code', () => {
    expect(formatTransportDiagnostic(fetchFailure())).toBe(' [name=TypeError]');
  });

  it('formats only the available cause fields', () => {
    expect(formatTransportDiagnostic(fetchFailure({ code: 'ECONNREFUSED' }))).toBe(
      ' [name=TypeError code=ECONNREFUSED]',
    );
  });

  it('returns an empty string for non-Error values', () => {
    expect(formatTransportDiagnostic('fetch failed')).toBe('');
    expect(formatTransportDiagnostic(null)).toBe('');
  });

  it('never includes the error message or arbitrary (potentially sensitive) fields', () => {
    const err = new TypeError('fetch failed for https://secret.example/?token=abc123');
    (err as { cause?: unknown }).cause = {
      code: 'EAI_AGAIN',
      errno: -3001,
      address: '10.0.0.1',
      port: 443,
      message: 'getaddrinfo EAI_AGAIN secret.example',
    };
    const out = formatTransportDiagnostic(err);
    expect(out).toBe(' [name=TypeError code=EAI_AGAIN]');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('10.0.0.1');
    expect(out).not.toContain('getaddrinfo '); // no free-form cause.message
  });
});
