import { Router } from 'express';
import { z } from 'zod';
import { intentCreateSchema } from '@agentproof/shared';
import { getIntentRepository, getEvidenceService, getIntentParser } from '../models/repositories.js';
import { detectCompoundIntent } from '../services/discovery/compoundGuard.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const intentRouter = Router();
intentRouter.use(requireAuth);

intentRouter.post('/', async (req, res) => {
  const parsed = intentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const intentRepository = getIntentRepository();
  const evidenceService = getEvidenceService();

  const { rawInput } = parsed.data;
  const id = generateId();
  const now = new Date().toISOString();

  let structured = parsed.data.structured;

  if (!structured) {
    try {
      const parsedIntent = await getIntentParser().parseIntent(rawInput);
      structured = parsedIntent.structured;

      // Deterministic safeguard: if the LLM omitted or mis-set isCompound,
      // detect compound requests directly from the raw input.
      if (!structured.isCompound && detectCompoundIntent(rawInput)) {
        structured = { ...structured, isCompound: true };
      }

      await evidenceService.record(
        {
          eventType: 'INTENT_PARSED',
          actor: 'llm',
          source: 'openrouter',
          intentId: id,
          data: { rawInput, structured, model: parsedIntent.model },
        },
        req.auth!.user.id,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI intent parsing failed';
      logger.error('AI intent parsing failed', { error: message });

      await evidenceService.record(
        {
          eventType: 'INTENT_PARSED',
          actor: 'llm',
          source: 'openrouter',
          intentId: id,
          data: { rawInput, error: message },
        },
        req.auth!.user.id,
      );

      res.status(502).json({ error: 'AI intent parsing failed', details: message });
      return;
    }
  }

  await intentRepository.create({
    id,
    userId: req.auth!.user.id,
    rawInput,
    structured,
    status: 'VALIDATED',
    createdAt: now,
    parsedAt: now,
    validatedAt: now,
  });

  // Record evidence (owned by the authenticated user)
  await evidenceService.record(
    {
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: id,
      data: { rawInput },
    },
    req.auth!.user.id,
  );

  await evidenceService.record(
    {
      eventType: 'INTENT_VALIDATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      intentId: id,
      data: { structured },
    },
    req.auth!.user.id,
  );

  logger.info('Intent created', { intentId: id });

  res.status(201).json({
    id,
    rawInput,
    structured,
    status: 'VALIDATED',
    createdAt: now,
  });
});

intentRouter.get('/', async (req, res) => {
  const intentRepository = getIntentRepository();
  const userId = req.auth!.user.id;

  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 25;

  const intents = await intentRepository.listForUser(userId, limit);
  res.json(intents);
});

intentRouter.get('/:id', async (req, res) => {
  const intentRepository = getIntentRepository();
  const userId = req.auth!.user.id;

  const intent = await intentRepository.getByIdForUser(req.params.id, userId);

  if (!intent) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  res.json(intent);
});
