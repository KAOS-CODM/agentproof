import { describe, expect, it } from 'vitest';
import { mergeRouteParams, parseHashRoute } from './router';

describe('hash route parsing', () => {
  it('keeps the query out of the route path', () => {
    expect(parseHashRoute('#/?intent=intent-1').path).toBe('/');
    expect(parseHashRoute('#/?intent=intent-1').params.get('intent')).toBe('intent-1');
    expect(parseHashRoute('#/payment/return?token=O-1&status=cancel').path).toBe(
      '/payment/return',
    );
    expect(parseHashRoute('#/payment/return?token=O-1').params.get('token')).toBe('O-1');
    expect(parseHashRoute('').path).toBe('/');
  });

  it('combines location and hash params with hash values taking precedence', () => {
    const params = mergeRouteParams('?token=outer&status=outer', '#/payment/return?token=inner');
    expect(params.get('token')).toBe('inner');
    expect(params.get('status')).toBe('outer');
  });
});
