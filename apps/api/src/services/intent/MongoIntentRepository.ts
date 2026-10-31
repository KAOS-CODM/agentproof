import type { Intent, StructuredIntent } from '@agentproof/shared';
import { structuredIntentSchema } from '@agentproof/shared';
import type { Db } from 'mongodb';
import type { IntentRepository, PersistedIntent } from './IntentRepository.js';

/**
 * MongoDB-backed implementation of the intent repository.
 *
 * Document contract (`intents`):
 *   { _id: string, rawInput: string, structured: object, status: string,
 *     createdAt: Date, parsedAt: Date | null, validatedAt: Date | null }
 *
 * `_id` is the application's string UUID (never an ObjectId) so ids stay
 * comparable across adapters. Timestamps are stored as BSON `Date` and mapped
 * back to the ISO strings the domain `Intent`/`PersistedIntent` types use.
 * Structured intent is embedded because it is always read whole and never
 * queried by subfield.
 */

interface IntentDoc {
  _id: string;
  userId?: string;
  rawInput: string;
  structured: StructuredIntent;
  status: Intent['status'];
  createdAt: Date;
  parsedAt: Date | null;
  validatedAt: Date | null;
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export class MongoIntentRepository implements IntentRepository {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<IntentDoc>('intents');
  }

  async create(intent: PersistedIntent): Promise<void> {
    // Unconditional insert: a duplicate _id raises and propagates rather than
    // silently overwriting an existing intent.
    const doc: IntentDoc = {
      _id: intent.id,
      rawInput: intent.rawInput,
      structured: intent.structured,
      status: intent.status,
      createdAt: new Date(intent.createdAt),
      parsedAt: toDate(intent.parsedAt),
      validatedAt: toDate(intent.validatedAt),
    };
    if (intent.userId) {
      (doc as any).userId = intent.userId;
    }
    await this.collection.insertOne(doc);
  }

  async getById(id: string): Promise<Intent | null> {
    const doc = await this.collection.findOne({ _id: id });
    if (!doc) return null;
    const structured = doc.structured as unknown;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return null;
    }
    const parsed = structuredIntentSchema.safeParse(structured);
    if (!parsed.success) {
      return null;
    }
    return {
      id: doc._id,
      rawInput: doc.rawInput,
      structured: parsed.data,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
      parsedAt: toIso(doc.parsedAt),
      validatedAt: toIso(doc.validatedAt),
    };
  }

  async getByIdForUser(id: string, userId: string): Promise<Intent | null> {
    const doc = await this.collection.findOne({ _id: id, userId });
    if (!doc) return null;
    const structured = doc.structured as unknown;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return null;
    }
    const parsed = structuredIntentSchema.safeParse(structured);
    if (!parsed.success) {
      return null;
    }
    return {
      id: doc._id,
      rawInput: doc.rawInput,
      structured: parsed.data,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
      parsedAt: toIso(doc.parsedAt),
      validatedAt: toIso(doc.validatedAt),
    };
  }

  async listForUser(userId: string, limit: number): Promise<Intent[]> {
    const docs = await this.collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const intents: Intent[] = [];
    for (const doc of docs) {
      const structured = doc.structured as unknown;
      if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
        continue;
      }
      const parsed = structuredIntentSchema.safeParse(structured);
      if (!parsed.success) continue;
      intents.push({
        id: doc._id,
        rawInput: doc.rawInput,
        structured: parsed.data,
        status: doc.status,
        createdAt: doc.createdAt.toISOString(),
        parsedAt: toIso(doc.parsedAt),
        validatedAt: toIso(doc.validatedAt),
      });
    }
    return intents;
  }

  async getStructuredById(id: string): Promise<StructuredIntent | null> {
    const doc = await this.collection.findOne(
      { _id: id },
      { projection: { structured: 1 } },
    );
    if (!doc || !doc.structured) return null;
    const structured = doc.structured as unknown;
    // Mirror the SQLite adapter: unparseable structured data is reported as
    // null (not-found) rather than thrown.
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return null;
    }
    const parsed = structuredIntentSchema.safeParse(structured);
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  }

  async getStructuredByIdForUser(id: string, userId: string): Promise<StructuredIntent | null> {
    const doc = await this.collection.findOne(
      { _id: id, userId },
      { projection: { structured: 1 } },
    );
    if (!doc || !doc.structured) return null;
    const structured = doc.structured as unknown;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return null;
    }
    const parsed = structuredIntentSchema.safeParse(structured);
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  }
}
