import { defineConfig } from 'vitest/config';

// Deliberately independent of vite.config.ts so unit tests never load the root
// .env (which vite.config.ts reads only to forward the public PayPal client id).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
