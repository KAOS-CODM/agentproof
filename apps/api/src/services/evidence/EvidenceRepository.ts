import type { EvidenceRecord } from '@agentproof/shared';

export interface EvidenceRepository {
  append(record: EvidenceRecord): void;
  getById(id: string): EvidenceRecord | null;
  getByIntentId(intentId: string): EvidenceRecord[];
  getByTransactionId(transactionId: string): EvidenceRecord[];
  getAll(): EvidenceRecord[];
}
