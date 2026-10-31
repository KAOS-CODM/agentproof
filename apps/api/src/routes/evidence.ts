import { Router } from 'express';
import { getEvidenceService } from '../models/repositories.js';
import { requireAuth } from '../middleware/auth.js';

export const evidenceRouter = Router();

// Evidence is always scoped to the authenticated owner. An ordinary user can
// list only their own records; ownerless/legacy rows are never returned and an
// unowned id is indistinguishable from a missing one.
evidenceRouter.use(requireAuth);

evidenceRouter.get('/', async (req, res) => {
  const evidenceService = getEvidenceService();
  const userId = req.auth!.user.id;

  const { intentId, transactionId } = req.query;

  if (typeof intentId === 'string') {
    const records = await evidenceService.getByIntentIdForUser(intentId, userId);
    res.json(records);
    return;
  }

  if (typeof transactionId === 'string') {
    const records = await evidenceService.getByTransactionIdForUser(transactionId, userId);
    res.json(records);
    return;
  }

  const records = await evidenceService.getAllForUser(userId);
  res.json(records);
});

evidenceRouter.get('/:id', async (req, res) => {
  const evidenceService = getEvidenceService();

  const record = await evidenceService.getByIdForUser(req.params.id, req.auth!.user.id);
  if (!record) {
    res.status(404).json({ error: 'Evidence record not found' });
    return;
  }
  res.json(record);
});
