import type {
  Collection,
  Db,
  Document,
  Filter,
  IndexDescription,
  UpdateFilter,
  UpdateResult,
} from 'mongodb';

/**
 * A minimal in-memory fake of the subset of the MongoDB driver API that the
 * repository adapters use (`insertOne`, `findOne`, `find().sort().toArray()`,
 * `updateOne`, `updateMany`, `createIndexes`). It exists so adapter semantics
 * can be tested without Atlas.
 *
 * Assignment behaves like a tiny Mongo: `$set` merges fields, `$setOnInsert`
 * seeds a newly upserted document, `_id` is unique, update filters honor
 * equality fields, `upsert: true` inserts when nothing matches, and duplicate
 * `_id`/unique-index keys raise an E11000-shaped error. Unique indexes are only
 * enforced after `createIndexes()` is called, matching the real server's
 * "index must exist" behavior.
 */

export class DuplicateKeyError extends Error {
  code = 11000;
  constructor(id: unknown) {
    super(`E11000 duplicate key error: ${String(id)}`);
  }
}

function matches(doc: Document, filter: Filter<Document>): boolean {
  return Object.entries(filter as Record<string, unknown>).every(([key, expected]) => {
    const actual = key === '_id' ? doc._id : doc[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      if ('$type' in ops) {
        const want = ops.$type;
        return want === 'string' ? typeof actual === 'string' : actual !== undefined;
      }
      return false;
    }
    return actual === expected;
  });
}

interface RecordedIndex {
  key: Record<string, 1 | -1>;
  name?: string;
  unique?: boolean;
  partialFilterExpression?: Document;
}

class FakeCollection {
  readonly docs: Document[] = [];
  private readonly indexes: RecordedIndex[] = [];

  constructor(private readonly failOn?: 'insert' | 'find' | 'update') {}

  private assertUnique(candidate: Document, ignore?: Document): void {
    for (const index of this.indexes) {
      if (!index.unique) continue;
      if (
        index.partialFilterExpression &&
        !matches(candidate, index.partialFilterExpression as Filter<Document>)
      ) {
        continue;
      }
      const keys = Object.keys(index.key);
      const values = keys.map((key) => candidate[key]);
      // Sparse-like behavior: a missing/null component cannot participate in a
      // unique key. P4 always populates email and tokenHash.
      if (values.some((value) => value === undefined || value === null)) continue;
      // A partial index only contains documents that match its filter, and
      // index membership is per-document. A document that leaves the filter
      // (e.g. a selection marked inactive) must stop occupying its unique slot,
      // so the existing document is tested against the filter too — filtering
      // only the candidate would keep stale conflicts alive.
      const inIndex = (doc: Document): boolean =>
        !index.partialFilterExpression ||
        matches(doc, index.partialFilterExpression as Filter<Document>);
      const conflict = this.docs.some(
        (doc) =>
          doc !== ignore && inIndex(doc) && keys.every((key) => doc[key] === candidate[key]),
      );
      if (conflict) {
        throw new DuplicateKeyError(values.join(','));
      }
    }
  }

  async insertOne(doc: Document): Promise<{ acknowledged: boolean; insertedId: unknown }> {
    if (this.failOn === 'insert') throw new Error('insert failed');
    if (this.docs.some((d) => d._id === doc._id)) throw new DuplicateKeyError(doc._id);
    this.assertUnique(doc);
    this.docs.push({ ...doc });
    return { acknowledged: true, insertedId: doc._id };
  }

  async findOne(filter: Filter<Document>): Promise<Document | null> {
    if (this.failOn === 'find') throw new Error('find failed');
    return this.docs.find((d) => matches(d, filter)) ?? null;
  }

  find(filter: Filter<Document> = {}) {
    if (this.failOn === 'find') throw new Error('find failed');
    let sortSpec: Record<string, 1 | -1> = {};
    let limitSpec: number | null = null;
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        sortSpec = spec;
        return cursor;
      },
      limit: (value: number) => {
        limitSpec = value;
        return cursor;
      },
      toArray: async () => {
        const rows = this.docs.filter((d) => matches(d, filter));
        const [[key, dir]] = Object.entries(sortSpec);
        if (key) {
          rows.sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            const an = av instanceof Date ? av.getTime() : (av as number);
            const bn = bv instanceof Date ? bv.getTime() : (bv as number);
            return an < bn ? -dir : an > bn ? dir : 0;
          });
        }
        return rows.slice(0, limitSpec ?? undefined).map((d) => ({ ...d }));
      },
    };
    return cursor;
  }

  async updateOne(
    filter: Filter<Document>,
    update: UpdateFilter<Document>,
    options: { upsert?: boolean } = {},
  ): Promise<UpdateResult> {
    if (this.failOn === 'update') throw new Error('update failed');
    const doc = this.docs.find((d) => matches(d, filter));
    const set = (update.$set ?? {}) as Record<string, unknown>;
    const unset = (update.$unset ?? {}) as Record<string, unknown>;

    if (doc) {
      const candidate = { ...doc, ...set };
      for (const key of Object.keys(unset)) delete candidate[key];
      this.assertUnique(candidate, doc);
      Object.assign(doc, set);
      for (const key of Object.keys(unset)) delete doc[key];
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true, upsertedCount: 0, upsertedId: null } as UpdateResult;
    }

    if (!options.upsert) {
      return { matchedCount: 0, modifiedCount: 0, acknowledged: true, upsertedCount: 0, upsertedId: null } as UpdateResult;
    }

    // Seed an upserted document from the filter's equality fields, then apply
    // $setOnInsert followed by $set (the latter wins on overlapping fields).
    const inserted: Document = {};
    for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) continue;
      inserted[key] = value;
    }
    const setOnInsert = (update.$setOnInsert ?? {}) as Record<string, unknown>;
    Object.assign(inserted, setOnInsert, set);
    for (const key of Object.keys(unset)) delete inserted[key];

    if (this.docs.some((d) => d._id === inserted._id)) {
      throw new DuplicateKeyError(inserted._id);
    }
    this.assertUnique(inserted);
    this.docs.push(inserted);
    return {
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
      upsertedCount: 1,
      upsertedId: inserted._id ?? null,
    } as UpdateResult;
  }

  async updateMany(
    filter: Filter<Document>,
    update: UpdateFilter<Document>,
  ): Promise<UpdateResult> {
    if (this.failOn === 'update') throw new Error('update failed');
    const matchesToUpdate = this.docs.filter((doc) => matches(doc, filter));
    const set = (update.$set ?? {}) as Record<string, unknown>;
    const unset = (update.$unset ?? {}) as Record<string, unknown>;

    // Validate every candidate before mutating anything so a uniqueness error
    // does not leave the fake half-updated.
    const candidates = matchesToUpdate.map((doc) => {
      const candidate = { ...doc, ...set };
      for (const key of Object.keys(unset)) delete candidate[key];
      this.assertUnique(candidate, doc);
      return candidate;
    });
    for (const [index, doc] of matchesToUpdate.entries()) {
      Object.assign(doc, candidates[index]);
    }
    return {
      matchedCount: matchesToUpdate.length,
      modifiedCount: candidates.length,
      acknowledged: true,
      upsertedCount: 0,
      upsertedId: null,
    } as UpdateResult;
  }

  async createIndexes(indexes: IndexDescription[] = []): Promise<string[]> {
    for (const index of indexes) {
      const key = index.key as Record<string, 1 | -1>;
      const existing = this.indexes.find(
        (candidate) =>
          candidate.name === index.name ||
          JSON.stringify(candidate.key) === JSON.stringify(key),
      );
      if (!existing) {
        this.indexes.push({
          key: { ...key },
          name: index.name,
          unique: index.unique,
          partialFilterExpression: index.partialFilterExpression as
            | Document
            | undefined,
        });
      }
    }
    return indexes.map((index) => index.name ?? '');
  }
}

export interface FakeDbOptions {
  /** Fail `insertOne`/`find*`/`updateOne` for every collection. */
  failOn?: 'insert' | 'find' | 'update';
}

export function createFakeDb(options: FakeDbOptions = {}): Db {
  const collections = new Map<string, FakeCollection>();
  const db = {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => {
      let c = collections.get(name);
      if (!c) {
        c = new FakeCollection(options.failOn);
        collections.set(name, c);
      }
      return c;
    },
  };
  return db as unknown as Db;
}

/** Access the raw documents of a fake collection (test-only). */
export function fakeDocs(db: Db, name: string): Document[] {
  return (db.collection(name) as unknown as FakeCollection).docs;
}

export type { Collection };
