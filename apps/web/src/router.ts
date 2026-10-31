import { useState, useEffect } from 'react';

/**
 * Split a hash route into its path and query, keeping the query out of the path
 * (so `/payment/return?token=…` still resolves to `/payment/return`).
 */
export function parseHashRoute(hash: string): {
  path: string;
  params: URLSearchParams;
} {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const route = raw || '/';
  const qIndex = route.indexOf('?');
  const path = qIndex === -1 ? route : route.slice(0, qIndex);
  const search = qIndex === -1 ? '' : route.slice(qIndex + 1);
  return { path: path || '/', params: new URLSearchParams(search) };
}

/** Merge real query-string parameters with hash parameters (hash wins). */
export function mergeRouteParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const hashParams = parseHashRoute(hash).params;
  for (const [key, value] of hashParams) params.set(key, value);
  return params;
}

export function currentRouteParams(): URLSearchParams {
  return mergeRouteParams(window.location.search, window.location.hash);
}

export function useHashRoute(): string {
  const [path, setPath] = useState(() => parseHashRoute(window.location.hash).path);

  useEffect(() => {
    function onChange() {
      setPath(parseHashRoute(window.location.hash).path);
    }
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return path;
}

export function useSearchParams(): [URLSearchParams] {
  const [params, setParams] = useState(currentRouteParams);

  useEffect(() => {
    function onChange() {
      setParams(currentRouteParams());
    }
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return [params];
}
