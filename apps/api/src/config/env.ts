import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config();
// Monorepo fallback: when started via `npm run dev -w apps/api`, cwd is apps/api,
// while .env lives at the repository root.
dotenv.config({ path: resolve(process.cwd(), '../../.env') });

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

/**
 * Parse a comma-separated hostname allowlist. Hostnames are compared exactly
 * by the handoff policy (subdomain expansion is never automatic). An empty
 * value intentionally produces an empty list.
 */
function parseHostList(value: string | undefined, defaultValue: string[]): string[] {
  if (value === undefined) return defaultValue;
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter((host) => host.length > 0);
}

// Channel3's documented tracked buy links use this host. The final redirect
// destination is NOT verified by AgentProof; operators should confirm the host
// before enabling the handoff. Keeping it server-side prevents client spoofing.
const DEFAULT_CHANNEL3_TRACKING_HOSTS = ['buy.trychannel3.com'];

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv,
  dbPath: process.env.DB_PATH || './data/agentproof.db',
  // Active persistence provider for the migrated domain repositories.
  //   sqlite (default) -> sql.js, preserving the original behavior.
  //   mongodb           -> MongoDB Atlas for intents, policy evaluations,
  //                        evidence records, transactions, shared offers, and
  //                        per-intent discoveries.
  // There is never an automatic fallback: an explicitly selected provider that
  // cannot initialize fails startup. Validation happens in
  // models/persistenceProvider.ts.
  persistenceProvider: process.env.PERSISTENCE_PROVIDER || 'sqlite',
  // MongoDB Atlas (P0 foundation). Server-side ONLY: MONGODB_URI contains
  // credentials and must never reach the frontend, bundles, logs, or responses.
  // Deliberately default to '' so a missing value is reported explicitly rather
  // than silently falling back to SQLite/in-memory storage. Neither value has a
  // safe default; validation happens in models/mongoClient.ts.
  mongodbUri: process.env.MONGODB_URI || '',
  mongodbDb: process.env.MONGODB_DB || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalBaseUrl: process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com',
  paypalReturnUrl: process.env.PAYPAL_RETURN_URL || '',
  paypalCancelUrl: process.env.PAYPAL_CANCEL_URL || '',
  channel3ApiKey: process.env.CHANNEL3_API_KEY || '',
  // Explicit product-discovery source. Empty defaults to the live Channel3 API;
  // "demo" opts into the in-memory demo catalog for development/tests only.
  discoveryProvider: process.env.DISCOVERY_PROVIDER || '',
  // P7 retailer handoff. Disabled by default; no UI action or endpoint is
  // exposed unless an operator explicitly enables it.
  retailerHandoffEnabled: parseBoolean(process.env.RETAILER_HANDOFF_ENABLED, false),
  // Exact hostnames permitted in addition to the merchant domain stored in the
  // snapshot. Missing -> documented Channel3 tracked-link host; set to an empty
  // value to allow only merchant domains.
  channel3AllowedLinkHosts: parseHostList(
    process.env.CHANNEL3_ALLOWED_LINK_HOSTS,
    DEFAULT_CHANNEL3_TRACKING_HOSTS,
  ),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  corsOrigin: process.env.CORS_ORIGIN || null,
  authSessionTtlMs: parsePositiveInt(process.env.AUTH_SESSION_TTL_HOURS, 24) * 60 * 60 * 1000,
  authCookieSecure: parseBoolean(process.env.AUTH_COOKIE_SECURE, nodeEnv === 'production'),
  // Default SameSite to 'strict' for development localhost compatibility.
  // Production operators should set AUTH_COOKIE_SAMESITE=none (with AUTH_COOKIE_SECURE=true)
  // via the Render dashboard or .env. An unsafe default of 'none' without Secure=true
  // is prevented by also defaulting authCookieSameSite to 'strict' when not explicitly
  // overridden; the explicit env var is the only path to production SameSite=None.
  authCookieSameSite:
    process.env.AUTH_COOKIE_SAMESITE || 'strict',
  authInitialEmail: process.env.AUTH_INITIAL_EMAIL || null,
  authInitialPassword: process.env.AUTH_INITIAL_PASSWORD || null,
};
