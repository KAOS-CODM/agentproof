import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function scryptAsync(password: string | Buffer, salt: string | Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must not be empty');
  }
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$1$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== 'string') return false;
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  // scrypt$1$N$r$p$salt$hash
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1') {
    return false;
  }
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  try {
    const salt = Buffer.from(parts[5], 'base64');
    const expected = Buffer.from(parts[6], 'base64');
    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;

async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(`agentproof-dummy-${randomBytes(12).toString('hex')}`);
  }
  return dummyHashPromise;
}

export async function verifyPasswordWithDummyOnUnknown(password: string, storedHash: string | null): Promise<boolean> {
  if (storedHash) {
    // Exactly one scrypt verification, same as the unknown-account path below.
    // Doing a second dummy verification here would make existing-account
    // failures measurably slower and leak account existence by timing.
    return verifyPassword(password, storedHash);
  }
  try {
    const dummy = await getDummyHash();
    await verifyPassword(password, dummy);
  } catch {
    // ignore
  }
  return false;
}
