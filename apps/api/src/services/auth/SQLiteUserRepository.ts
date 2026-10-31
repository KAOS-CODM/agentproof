import type {
  PersistedUser,
  User,
  UserRepository,
  UserWithPasswordHash,
} from './UserRepository.js';
import { normalizeEmail } from './UserRepository.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

const PUBLIC_COLUMNS = 'id, email, created_at';

function rowToUser(row: Pick<UserRow, 'id' | 'email' | 'created_at'>): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  };
}

/**
 * sql.js-backed user repository.
 *
 * The `users.email` column is UNIQUE and stores the normalized value, so
 * case/whitespace variants cannot create duplicate accounts. Password hashes
 * are stored verbatim (never plaintext) and are only selected by the explicit
 * credentials lookup.
 */
export class SQLiteUserRepository implements UserRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async create(user: PersistedUser): Promise<void> {
    const email = normalizeEmail(user.email);
    this.db.run(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [user.id, email, user.passwordHash, user.createdAt],
    );
  }

  async getById(id: string): Promise<User | null> {
    const stmt = this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`);
    stmt.bind([id]);
    let row: Pick<UserRow, 'id' | 'email' | 'created_at'> | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as Pick<UserRow, 'id' | 'email' | 'created_at'>;
    }
    stmt.free();
    return row ? rowToUser(row) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const stmt = this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`);
    stmt.bind([normalizeEmail(email)]);
    let row: Pick<UserRow, 'id' | 'email' | 'created_at'> | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as Pick<UserRow, 'id' | 'email' | 'created_at'>;
    }
    stmt.free();
    return row ? rowToUser(row) : null;
  }

  async getCredentialsByEmail(email: string): Promise<UserWithPasswordHash | null> {
    const stmt = this.db.prepare(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = ?',
    );
    stmt.bind([normalizeEmail(email)]);
    let row: UserRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as UserRow;
    }
    stmt.free();
    if (!row) return null;
    return { ...rowToUser(row), passwordHash: row.password_hash };
  }
}
