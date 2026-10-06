import { Router } from 'express';
import { z } from 'zod';
import { intentCreateSchema } from '@agentproof/shared';
import { getDb } from '../models/db.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { AIService } from '../services/ai/AIService.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

export const intentRouter = Router();

const aiService = new AIService();

intentRouter.post('/', async (req, res) => {
  const parsed = intentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  const { rawInput } = parsed.data;
  const id = generateId();
  const now = new Date().toISOString();

  let structured = parsed.data.structured;

  if (!structured) {
    try {
      const parsedIntent = await aiService.parseIntent(rawInput);
      structured = parsedIntent.structured;

      evidenceService.record({
        eventType: 'INTENT_PARSED',
        actor: 'llm',
        source: 'openrouter',
        intentId: id,
        data: { rawInput, structured, model: parsedIntent.model },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI intent parsing failed';
      logger.error('AI intent parsing failed', { error: message });

      evidenceService.record({
        eventType: 'INTENT_PARSED',
        actor: 'llm',
        source: 'openrouter',
        intentId: id,
        data: { rawInput, error: message },
      });

      res.status(502).json({ error: 'AI intent parsing failed', details: message });
      return;
    }
  }

  db.run(
    `INSERT INTO intents (id, raw_input, structured_json, status, created_at, parsed_at, validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, rawInput, JSON.stringify(structured), 'VALIDATED', now, now, now],
  );

  // Record evidence
  evidenceService.record({
    eventType: 'INTENT_CREATED',
    actor: 'user',
    source: 'user_input',
    intentId: id,
    data: { rawInput },
  });

  evidenceService.record({
    eventType: 'INTENT_VALIDATED',
    actor: 'policy_engine',
    source: 'policy_engine',
    intentId: id,
    data: { structured },
  });

  logger.info('Intent created', { intentId: id });

  res.status(201).json({
    id,
    rawInput,
    structured,
    status: 'VALIDATED',
    createdAt: now,
  });
});

intentRouter.get('/:id', (req, res) => {
  const db = getDb();

  const stmt = db.prepare('SELECT * FROM intents WHERE id = ?');
  stmt.bind([req.params.id]);
  let row: unknown = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();

  if (!row) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  const r = row as {
    id: string;
    raw_input: string;
    structured_json: string;
    status: string;
    created_at: string;
    parsed_at: string | null;
    validated_at: string | null;
  };

  res.json({
    id: r.id,
    rawInput: r.raw_input,
    structured: JSON.parse(r.structured_json),
    status: r.status,
    createdAt: r.created_at,
    parsedAt: r.parsed_at,
    validatedAt: r.validated_at,
  });
});
