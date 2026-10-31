/**
 * Public user record. It deliberately does NOT carry credentials: the password
 * hash is only exposed by the explicit credentials lookup used by the
 * server-side login flow.
 */
export interface User {
  id: string;
  email: string;
  createdAt: string;
}

/**
 * The persistence-layer input for an account plus the one credential the
 * repository stores.
 *
 * `passwordHash` MUST already be a one-way hash produced by the caller. The
 * repository never hashes, verifies, or logs credentials, and there is no
 * plaintext `password` field anywhere in the contract.
 */
export interface UserWithPasswordHash extends User {
  passwordHash: string;
}

/** Input for creating a user. */
export type PersistedUser = UserWithPasswordHash;

/**
 * Normalize an email before storing or looking it up.
 *
 * Uniqueness is enforced on the normalized value, so case and surrounding
 * whitespace can never create a second account for the same address.
 */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error('Email must not be empty');
  }
  return normalized;
}

/**
 * Server-side account store used by authentication. Normal reads never return
 * the password hash; only
 * `getCredentialsByEmail` does, and that method is intended for server-side
 * verification only.
 */
export interface UserRepository {
  /**
   * Persist a new account. The email is normalized first and the configured
   * unique constraint rejects a duplicate address instead of overwriting it.
   */
  create(user: PersistedUser): Promise<void>;

  /** Load a public user by id, or null when unknown. */
  getById(id: string): Promise<User | null>;

  /** Load a public user by normalized email, or null when unknown. */
  getByEmail(email: string): Promise<User | null>;

  /**
   * Load the credential record needed to verify a login attempt. The hash must
   * never be sent to a client or included in a public response.
   */
  getCredentialsByEmail(email: string): Promise<UserWithPasswordHash | null>;
}
