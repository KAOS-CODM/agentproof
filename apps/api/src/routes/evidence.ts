import { Router } from 'express';
import { getDb } from '../models/db.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';

export const evidenceRouter = Router();

evidenceRouter.get('/', (req, res) => {
  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  const { intentId, transactionId } = req.query;

  if (typeof intentId === 'string') {
    const records = evidenceService.getByIntentId(intentId);
    res.json(records);
    return;
  }

  if (typeof transactionId === 'string') {
    const records = evidenceService.getByTransactionId(transactionId);
    res.json(records);
    return;
  }

  const records = evidenceService.getAll();
  res.json(records);
});

evidenceRouter.get('/:id', (req, res) => {
  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  const record = evidenceService.getById(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Evidence record not found' });
    return;
  }
  res.json(record);
});
