import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The repo-root .env is the single source of truth for local-development
// fallbacks. Render injects environment variables into process.env, which takes
// precedence so the dashboard can configure the API URL and PayPal client ID.
const repoRoot = resolve(process.cwd(), '..');

// Check process.env first, then fall back to root .env for local development.
// This ensures Render-declared values override the .env file, while developers
// can still set values in .env for local runs without modifying the dashboard.
function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    // .env may be absent; the frontend then shows "PayPal client ID is not configured."
  }
  return out;
}

// Process env takes precedence over .env for production variables.
// Missing values safely fall back to empty strings.
const env = {
  VITE_PAYPAL_CLIENT_ID:
    process.env.VITE_PAYPAL_CLIENT_ID ||
    readEnvFile(resolve(repoRoot, '.env')).PAYPAL_CLIENT_ID ||
    '',
  VITE_API_URL:
    process.env.VITE_API_URL || readEnvFile(resolve(repoRoot, '.env')).VITE_API_URL || '',
};

export default defineConfig({
  plugins: [react()],
  // Forward the public client ID and API URL to the browser under the VITE_ name
  // the frontend reads. PAYPAL_CLIENT_SECRET is never referenced and never bundled;
  // Vite's envPrefix stays the default (VITE_), so nothing else from .env leaks.
  define: {
    'import.meta.env.VITE_PAYPAL_CLIENT_ID': JSON.stringify(env.VITE_PAYPAL_CLIENT_ID),
    'import.meta.env.VITE_API_URL': JSON.stringify(env.VITE_API_URL),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});