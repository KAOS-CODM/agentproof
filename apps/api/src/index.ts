import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { initDb } from './models/db.js';
import { intentRouter } from './routes/intent.js';
import { policyRouter } from './routes/policy.js';
import { evidenceRouter } from './routes/evidence.js';
import { logger } from './utils/logger.js';

async function main() {
  await initDb();

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'agentproof-api',
      timestamp: new Date().toISOString(),
    });
  });

  // API routes
  app.use('/api/v1/intent', intentRouter);
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/evidence', evidenceRouter);

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

  app.listen(config.port, () => {
    logger.info(`AgentProof API listening on port ${config.port}`, {
      env: config.nodeEnv,
    });
  });
}

main().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});
