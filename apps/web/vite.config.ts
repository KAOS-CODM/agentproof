import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The repo-root .env is the single source of truth for PayPal credentials.
// Scripts run from apps/web, so the repo root is two directories up.
const repoRoot = resolve(process.cwd(), '../..');

// Read exactly ONE key from the root .env without using Vite's env loading.
// Vite's loadEnv / envDir would also load NODE_ENV=development from this file,
// which makes every production build use the React *development* bundle
// (VITE_USER_NODE_ENV handling). Parsing the file ourselves avoids that.
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

const env = readEnvFile(resolve(repoRoot, '.env'));

export default defineConfig({
  plugins: [react()],
  // Forward the single public client ID to the browser under the VITE_ name the
  // frontend reads. PAYPAL_CLIENT_SECRET is never referenced and never bundled;
  // Vite's envPrefix stays the default (VITE_), so nothing else from .env leaks.
  define: {
    'import.meta.env.VITE_PAYPAL_CLIENT_ID': JSON.stringify(env.PAYPAL_CLIENT_ID || ''),
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