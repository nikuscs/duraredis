import { SCHEMA } from "../store/schema";
import { hex, sha256 } from "../store/sha256";

export const DB_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;

export interface Meta {
  name: string;
  createdAt: number;
  expiresAt: number | null;
  salt: string;
  passwordHash: string | null;
}

const META_KEY = "duraredis:meta";

const GUARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_failures (
  client TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_client ON auth_failures(client, at);
`;

export const ensureSchema = (storage: DurableObjectStorage) => storage.sql.exec(`${SCHEMA}\n${GUARD_SCHEMA}`);

const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export const readMeta = (storage: DurableObjectStorage) => storage.kv.get<Meta>(META_KEY);

export const hashPassword = (salt: string, password: string) => hex(sha256(new TextEncoder().encode(`${salt}:${password}`)));

export function createDatabase(storage: DurableObjectStorage, name: string, ttlSeconds: number, password: string): Meta {
  const now = Date.now();
  const salt = newSalt();
  const meta: Meta = {
    name, createdAt: now, salt,
    expiresAt: ttlSeconds > 0 ? now + ttlSeconds * 1000 : null,
    passwordHash: password ? hashPassword(salt, password) : null,
  };
  ensureSchema(storage);
  storage.kv.put(META_KEY, meta);
  if (meta.expiresAt !== null) void storage.setAlarm(meta.expiresAt);
  return meta;
}

export function changePassword(storage: DurableObjectStorage, meta: Meta, password: string | null) {
  const salt = newSalt();
  storage.kv.put(META_KEY, { ...meta, salt, passwordHash: password === null ? null : hashPassword(salt, password) });
  storage.sql.exec("DELETE FROM auth_failures");
}
