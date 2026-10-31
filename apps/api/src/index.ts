import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { config } from './config/env.js';
import { initializePersistence, registerShutdownHandlers, makeServerShutdown } from './models/startup.js';
import { resolvePersistenceProvider } from './models/persistenceProvider.js';
import { intentRouter } from './routes/intent.js';
import { policyRouter } from './routes/policy.js';
import { evidenceRouter } from './routes/evidence.js';
import { productsRouter } from './routes/products.js';
import { paymentsRouter } from './routes/payments.js';
import { selectionsRouter } from './routes/selections.js';
import { authRouter } from './routes/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { logger } from './utils/logger.js';

async function main() {
  // Select and initialize persistence BEFORE the server accepts requests. A
  // mongodb selection connects, verifies, and creates indexes here; any failure
  // aborts startup with no fallback to SQLite.
  const provider = resolvePersistenceProvider();
  const persistence = await initializePersistence(provider);
  logger.info('Persistence initialized', {
    provider: persistence.provider,
  });

  const app = express();

  app.use(
    cors({
      origin: config.webOrigin,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(csrfProtection);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'agentproof-api',
      timestamp: new Date().toISOString(),
    });
  });

  // Auth (public login/logout; session requires auth middleware on the route)
  app.use('/api/v1/auth', authRouter);

  // API routes (protected below in each router; requireAuth applied per-router)
  app.use('/api/v1/intent', intentRouter);
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/evidence', evidenceRouter);
  app.use('/api/v1/products', productsRouter);
  app.use('/api/v1/selections', selectionsRouter);
  app.use('/api/v1/payments', paymentsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error('Unhandled error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  const server = http.createServer(app);

  // Stop accepting requests, then release persistence resources safely.
  const shutdown = makeServerShutdown(server, persistence);
  registerShutdownHandlers(async () => {
    logger.info('Shutting down');
    await shutdown();
  });

  server.listen(config.port, () => {
    logger.info(`AgentProof API listening on port ${config.port}`, {
      env: config.nodeEnv,
    });
  });
}

main().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});
