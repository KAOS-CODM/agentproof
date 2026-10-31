import type { Collection, Db } from 'mongodb';
import type {
  PersistedUser,
  User,
  UserRepository,
  UserWithPasswordHash,
} from './UserRepository.js';
import { normalizeEmail } from './UserRepository.js';

/**
 * MongoDB-backed user repository.
 *
 * Document contract (`users`):
 *   { _id: string, email: string, passwordHash: string, createdAt: Date }
 *
 * `email` is stored normalized and is protected by the unique `uniq_email`
 * index created at startup. Normal reads project the hash away; only
 * `getCredentialsByEmail` returns it.
 */

interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

function toUser(doc: UserDoc): User {
  return {
    id: doc._id,
    email: doc.email,
    createdAt: doc.createdAt.toISOString(),
  };
}

export class MongoUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  private get collection(): Collection<UserDoc> {
    return this.db.collection<UserDoc>('users');
  }

  async create(user: PersistedUser): Promise<void> {
    // Unconditional insert: the unique email index rejects a duplicate address
    // (and the _id rejects a duplicate id) rather than overwriting an account.
    await this.collection.insertOne({
      _id: user.id,
      email: normalizeEmail(user.email),
      passwordHash: user.passwordHash,
      createdAt: new Date(user.createdAt),
    });
  }

  async getById(id: string): Promise<User | null> {
    const doc = await this.collection.findOne(
      { _id: id },
      { projection: { passwordHash: 0 } },
    );
    return doc ? toUser(doc) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const doc = await this.collection.findOne(
      { email: normalizeEmail(email) },
      { projection: { passwordHash: 0 } },
    );
    return doc ? toUser(doc) : null;
  }

  async getCredentialsByEmail(email: string): Promise<UserWithPasswordHash | null> {
    const doc = await this.collection.findOne({ email: normalizeEmail(email) });
    if (!doc) return null;
    return { ...toUser(doc), passwordHash: doc.passwordHash };
  }
}
