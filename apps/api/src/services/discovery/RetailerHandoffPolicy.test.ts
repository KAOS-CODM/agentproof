import { describe, expect, it } from 'vitest';
import {
  RETAILER_AFFILIATE_DISCLOSURE,
  validateRetailerUrl,
  type RetailerUrlPolicy,
} from './RetailerHandoffPolicy.js';

const merchantPolicy: RetailerUrlPolicy = {
  merchant: 'shoebacca.com',
  allowedTrackingHosts: ['buy.trychannel3.com'],
};

function expectRejected(raw: string, reason: string, policy = merchantPolicy) {
  const result = validateRetailerUrl(raw, policy);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('validateRetailerUrl', () => {
  it('accepts an HTTPS merchant URL and preserves tracking parameters exactly', () => {
    const raw =
      'https://www.shoebacca.com/p/runfalcon-3?utm_source=channel3&aff=abc%2F123#details';
    expect(validateRetailerUrl(raw, merchantPolicy)).toEqual({
      ok: true,
      url: raw,
      hostname: 'www.shoebacca.com',
    });
  });

  it('accepts the documented Channel3 tracked host only when explicitly allowlisted', () => {
    const raw = 'https://buy.trychannel3.com/abc';
    expect(validateRetailerUrl(raw, merchantPolicy)).toEqual({
      ok: true,
      url: raw,
      hostname: 'buy.trychannel3.com',
    });
    expectRejected(
      raw,
      'HOST_NOT_APPROVED',
      { merchant: 'shoebacca.com', allowedTrackingHosts: [] },
    );
  });

  it('rejects non-HTTPS schemes', () => {
    expectRejected('http://shoebacca.com/p/1', 'NOT_HTTPS');
    expectRejected('javascript:alert(1)', 'NOT_HTTPS');
    expectRejected('data:text/html,hello', 'NOT_HTTPS');
    expectRejected('file:///tmp/offer', 'NOT_HTTPS');
  });

  it('rejects malformed URLs and unsafe characters', () => {
    expectRejected('not a url', 'UNSAFE_CHARACTERS');
    expectRejected('https://', 'MALFORMED');
    expectRejected(' https://shoebacca.com/p/1', 'UNSAFE_CHARACTERS');
    expectRejected('https://shoebacca.com\\@evil.example/p/1', 'UNSAFE_CHARACTERS');
  });

  it('rejects embedded credentials', () => {
    expectRejected('https://user:pass@shoebacca.com/p/1', 'CREDENTIALS');
    expectRejected('https://user@shoebacca.com/p/1', 'CREDENTIALS');
  });

  it('rejects deceptive hostnames and suffix lookalikes', () => {
    expectRejected('https://shoebacca.com.evil.example/p/1', 'HOST_NOT_APPROVED');
    expectRejected('https://evil-shoebacca.com/p/1', 'HOST_NOT_APPROVED');
    expectRejected('https://notshoebacca.com/p/1', 'HOST_NOT_APPROVED');
    expectRejected('https://shoebacca.co/p/1', 'HOST_NOT_APPROVED');
    expectRejected('https://buy.trychannel3.com.evil.example/abc', 'HOST_NOT_APPROVED');
  });

  it('does not widen tracking-host trust to subdomains automatically', () => {
    expectRejected('https://other.trychannel3.com/abc', 'HOST_NOT_APPROVED');
  });

  it('rejects unexpected ports but accepts the default HTTPS port', () => {
    expectRejected('https://shoebacca.com:8443/p/1', 'UNEXPECTED_PORT');
    const defaultPort = validateRetailerUrl('https://shoebacca.com:443/p/1', merchantPolicy);
    expect(defaultPort.ok).toBe(true);
  });

  it('rejects absolute redirect destinations smuggled through query parameters', () => {
    expectRejected(
      'https://shoebacca.com/out?url=https://evil.example/phish',
      'UNSAFE_REDIRECT_PARAMETER',
    );
    expectRejected(
      'https://buy.trychannel3.com/out?redirect=https%3A%2F%2Fevil.example',
      'UNSAFE_REDIRECT_PARAMETER',
    );
    expectRejected(
      'https://shoebacca.com/out?next=%2F%2Fevil.example',
      'UNSAFE_REDIRECT_PARAMETER',
    );
  });

  it('allows ordinary relative query parameters that are not redirects', () => {
    const raw = 'https://shoebacca.com/p/1?size=10&color=black';
    expect(validateRetailerUrl(raw, merchantPolicy).ok).toBe(true);
  });

  it('accepts a trailing-dot hostname after safe normalization', () => {
    expect(validateRetailerUrl('https://shoebacca.com./p/1', merchantPolicy)).toEqual({
      ok: true,
      url: 'https://shoebacca.com./p/1',
      hostname: 'shoebacca.com',
    });
  });

  it('rejects non-string input and missing merchant approval', () => {
    expect(validateRetailerUrl(undefined, merchantPolicy)).toEqual({
      ok: false,
      reason: 'NOT_A_STRING',
    });
    expectRejected(
      'https://shoebacca.com/p/1',
      'HOST_NOT_APPROVED',
      { merchant: null, allowedTrackingHosts: [] },
    );
  });

  it('exposes the exact affiliate disclosure required by Channel3', () => {
    expect(RETAILER_AFFILIATE_DISCLOSURE).toBe(
      'We may earn a commission when you buy through links on this page.',
    );
  });
});
