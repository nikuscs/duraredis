import { SCHEMA } from "../store/schema";
import { constantTimeEqual, hex, sha256 } from "../store/sha256";

export const DB_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;

export interface Meta {
  name: string;
  createdAt: number;
  expiresAt: number | null;
  salt: string;
  passwordHash: string | null;
}

const META_KEY = "duraredis:meta";

export const readMeta = (storage: DurableObjectStorage) => storage.kv.get<Meta>(META_KEY);

const hashPassword = (salt: string, password: string) => hex(sha256(new TextEncoder().encode(`${salt}:${password}`)));

export function createDatabase(storage: DurableObjectStorage, name: string, ttlSeconds: number, password: string): Meta {
  const now = Date.now();
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const meta: Meta = {
    name, createdAt: now, salt,
    expiresAt: ttlSeconds > 0 ? now + ttlSeconds * 1000 : null,
    passwordHash: password ? hashPassword(salt, password) : null,
  };
  storage.sql.exec(SCHEMA);
  storage.kv.put(META_KEY, meta);
  if (meta.expiresAt !== null) void storage.setAlarm(meta.expiresAt);
  return meta;
}

export function passwordMatches(meta: Meta, password: string): boolean {
  if (meta.passwordHash === null) return true;
  return constantTimeEqual(hashPassword(meta.salt, password), meta.passwordHash);
}
