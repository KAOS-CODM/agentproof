import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OfferSnapshotView, PolicyEvaluation } from '@agentproof/shared';
import type { DiscoverCandidate } from './api';
import { CandidateCard } from './components/CandidateCard';
import { RetailerHandoff } from './components/RetailerHandoff';
import {
  formatOfferPrice,
  handoffOfferMatches,
  isSafeRetailerNavigationUrl,
  offerForCandidate,
  RETAILER_AFFILIATE_DISCLOSURE,
} from './handoff';

const snapshot: OfferSnapshotView = {
  id: 'snap-1',
  source: 'channel3',
  productId: 'channel3:runfalcon',
  externalProductId: '1FesGXD',
  productName: 'Runfalcon 3.0',
  brand: 'adidas',
  merchant: 'shoebacca.com',
  price: 44.95,
  currency: 'USD',
  availability: 'InStock',
  condition: 'new',
  compareAtPrice: 65,
  maxCommissionRate: 0.05,
  capturedAt: '2026-10-20T10:00:00.000Z',
};

const evaluation: PolicyEvaluation = {
  id: 'pe-1',
  intentId: 'intent-1',
  productId: 'channel3:runfalcon',
  result: 'ALLOW',
  confirmationRequired: false,
  ruleResults: [],
  evaluatedAt: '2026-10-20T10:00:00.000Z',
};

const candidate: DiscoverCandidate = {
  product: {
    id: 'channel3:runfalcon',
    source: 'channel3',
    name: 'Runfalcon 3.0',
    description: 'Running shoes',
    price: 99,
    currency: 'USD',
    brand: 'adidas',
    condition: 'new',
    category: 'Running Shoes',
    merchant: 'shoebacca.com',
    productUrl: 'https://shoebacca.com/p/runfalcon-3',
  },
  evaluation,
  snapshot,
  snapshotFresh: true,
};

function handoffMarkup(overrides: Partial<React.ComponentProps<typeof RetailerHandoff>> = {}) {
  return renderToStaticMarkup(
    React.createElement(RetailerHandoff, {
      enabled: true,
      eligible: true,
      snapshot,
      loading: false,
      error: null,
      onContinue: () => {},
      ...overrides,
    }),
  );
}

describe('retailer handoff helpers', () => {
  it('accepts only plain HTTPS navigation URLs', () => {
    expect(isSafeRetailerNavigationUrl('https://shoebacca.com/p/1?aff=1')).toBe(true);
    expect(isSafeRetailerNavigationUrl('http://shoebacca.com/p/1')).toBe(false);
    expect(isSafeRetailerNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeRetailerNavigationUrl('https://user:pass@shoebacca.com/p/1')).toBe(false);
    expect(isSafeRetailerNavigationUrl('https://shoebacca.com:8443/p/1')).toBe(false);
    expect(isSafeRetailerNavigationUrl('not a url')).toBe(false);
  });

  it('formats the snapshot price and never derives a snapshot from the product', () => {
    expect(formatOfferPrice(44.95, 'USD')).toContain('44.95');
    expect(offerForCandidate(candidate)?.price).toBe(44.95);
    expect(offerForCandidate({ ...candidate, snapshot: null })).toBeNull();
    expect(offerForCandidate(null)).toBeNull();
  });

  it('requires the server-returned offer to match the displayed snapshot', () => {
    expect(handoffOfferMatches(snapshot, snapshot)).toBe(true);
    expect(handoffOfferMatches(snapshot, null)).toBe(false);
    expect(handoffOfferMatches(snapshot, { ...snapshot, id: 'snap-other' })).toBe(false);
    expect(handoffOfferMatches(snapshot, { ...snapshot, source: 'demo_catalog' })).toBe(false);
    expect(handoffOfferMatches(snapshot, { ...snapshot, productId: 'other' })).toBe(false);
    expect(handoffOfferMatches(snapshot, { ...snapshot, price: 1 })).toBe(false);
    expect(handoffOfferMatches(snapshot, { ...snapshot, currency: 'EUR' })).toBe(false);
  });
});

describe('RetailerHandoff', () => {
  it('renders nothing when the server feature flag is disabled', () => {
    expect(handoffMarkup({ enabled: false })).toBe('');
  });

  it('shows snapshot merchant, price, disclosure, and an explicit action', () => {
    const markup = handoffMarkup();
    expect(markup).toContain('Retailer offer');
    expect(markup).toContain('shoebacca.com');
    expect(markup).toContain('44.95');
    expect(markup).toContain('USD');
    expect(markup).toContain(RETAILER_AFFILIATE_DISCLOSURE);
    expect(markup).toContain('Continue to retailer');
    expect(markup).toContain('complete your purchase on the merchant');
    expect(markup).not.toContain('<a ');
    expect(markup.toLowerCase()).not.toContain('purchase completed');
  });

  it('shows a safe fallback instead of a fabricated URL for legacy snapshots', () => {
    const markup = handoffMarkup({ snapshot: null });
    expect(markup).toContain('No immutable offer snapshot');
    expect(markup).toContain('Re-run discovery');
    expect(markup).not.toContain('Continue to retailer');
  });

  it('does not offer the action when the server marks the snapshot stale', () => {
    const markup = handoffMarkup({ eligible: false });
    expect(markup).toContain('older than AgentProof');
    expect(markup).toContain('Re-run discovery');
    expect(markup).not.toContain('Continue to retailer');
  });

  it('shows an error without claiming a purchase', () => {
    const markup = handoffMarkup({ error: 'The retailer link for this offer is not approved.' });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('not approved');
    expect(markup.toLowerCase()).not.toContain('purchase completed');
  });
});

describe('CandidateCard', () => {
  it('selects an offer without navigating or claiming authorization', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'none',
        onSelect: () => {},
      }),
    );
    expect(markup).toContain('Select offer');
    expect(markup).toContain('44.95');
    expect(markup).toContain('shoebacca.com');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('Buy this');
  });

  it('marks a saved selection without changing its meaning', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'persisted',
        onSelect: () => {},
      }),
    );
    expect(markup).toContain('Selected');
    expect(markup).toContain('Your selection');
    expect(markup).not.toContain('Continue to retailer');
  });

  it('distinguishes a pending click from a saved choice', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'pending',
        onSelect: () => {},
      }),
    );
    expect(markup).toContain('Saving selection');
    expect(markup).toContain('Saving…');
    expect(markup).not.toContain('Your selection');
  });

  it('labels a recommendation and a fallback without calling them selected', () => {
    const recommendation = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'recommendation',
        onSelect: () => {},
      }),
    );
    const fallback = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'fallback',
        onSelect: () => {},
      }),
    );

    expect(recommendation).toContain('AI recommendation');
    expect(fallback).toContain('Fallback option');
    for (const markup of [recommendation, fallback]) {
      expect(markup).toContain('Select offer');
      expect(markup).not.toContain('Your selection');
      expect(markup).not.toContain('>Selected<');
    }
  });

  it('does not call a failed save or an older row the current selection', () => {
    const failed = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'save_failed',
        onSelect: () => {},
      }),
    );
    const previous = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate,
        state: 'previously_saved',
        onSelect: () => {},
      }),
    );

    expect(failed).toContain('Selection not saved');
    expect(failed).toContain('Save again');
    expect(previous).toContain('Previously saved');
    for (const markup of [failed, previous]) {
      expect(markup).not.toContain('Your selection');
      expect(markup).not.toContain('>Selected<');
    }
  });

  it('cannot select an offer that has no immutable snapshot', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate: { ...candidate, snapshot: null },
        state: 'none',
        onSelect: () => {},
      }),
    );
    expect(markup).toContain('No immutable offer snapshot');
    expect(markup).toContain('Re-run discovery');
    expect(markup).toContain('disabled');
  });

  it('cannot select an offer whose snapshot is stale', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CandidateCard, {
        candidate: { ...candidate, snapshotFresh: false },
        state: 'none',
        onSelect: () => {},
      }),
    );
    expect(markup).toContain('older than AgentProof');
    expect(markup).toContain('Re-run discovery');
    expect(markup).toContain('disabled');
  });
});
