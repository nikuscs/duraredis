import { RedisError } from "../resp/reply";
import { EXPIRING_MEMBERS, keyType, MEMBER_TABLES, TYPE, TYPE_NAME } from "./schema";
import type { KeyType } from "./schema";

export interface KeyRow {
  id: number;
  type: KeyType;
  value: Uint8Array | null;
  expiresAt: number | null;
}

export interface ScanPage {
  keys: Array<{ key: Uint8Array; type: KeyType }>;
  next: number;
}

export const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

const SWEEP_BATCH = 20;
const SWEEP_EVERY_MS = 100;
const MAX_ROW_BYTES = 2_000_000;
const LIVE = "(expires_at IS NULL OR expires_at > ?)";

export function blob(b: Uint8Array): ArrayBuffer {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return b.slice().buffer;
}

export const fromBlob = (v: SqlStorageValue): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : new TextEncoder().encode(String(v)));

export function keyString(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function checkSize(...parts: Array<Uint8Array | null>) {
  const n = parts.reduce((sum, p) => sum + (p?.length ?? 0), 0);
  if (n > MAX_ROW_BYTES) throw new RedisError("ERR duraredis: a key and its value must fit in 2 MB");
}

export class Keyspace {
  onChange: (key: Uint8Array) => void = () => {};
  private lastSweep = 0;
  beforeFlush: () => void = () => {};

  constructor(readonly sql: SqlStorage) {}

  get(key: Uint8Array): KeyRow | undefined {
    const row = this.sql.exec<{ id: number; type: number; value: ArrayBuffer | null; expires_at: number | null }>(
      "SELECT id, type, value, expires_at FROM keys WHERE key = ?", blob(key)).toArray()[0];
    if (!row) return undefined;
    const type = keyType(row.type);
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.deleteRow(row.id, type);
      this.onChange(key);
      return undefined;
    }
    if (this.purgeMembers(row.id, key, type)) return this.get(key);
    return { id: row.id, type, value: row.value ? new Uint8Array(row.value) : null, expiresAt: row.expires_at };
  }

  getTyped(key: Uint8Array, type: KeyType): KeyRow | undefined {
    const row = this.get(key);
    if (row && row.type !== type) throw new RedisError(WRONGTYPE);
    return row;
  }

  exists(key: Uint8Array): boolean {
    return this.get(key) !== undefined;
  }

  create(key: Uint8Array, type: KeyType, value: Uint8Array | null = null, expiresAt: number | null = null): number {
    checkSize(key, value);
    const row = this.sql.exec<{ id: number }>("INSERT INTO keys (key, type, value, expires_at) VALUES (?, ?, ?, ?) RETURNING id",
      blob(key), type, value ? blob(value) : null, expiresAt).one();
    this.onChange(key);
    return row.id;
  }

  setString(key: Uint8Array, value: Uint8Array, expiresAt: number | null = null, keepTtl = false) {
    checkSize(key, value);
    const old = this.get(key);
    const expiry = keepTtl ? (old?.expiresAt ?? null) : expiresAt;
    if (old?.type !== TYPE.string) {
      if (old) this.deleteRow(old.id, old.type);
      this.create(key, TYPE.string, value, expiry);
      return;
    }
    this.sql.exec("UPDATE keys SET value = ?, expires_at = ? WHERE id = ?", blob(value), expiry, old.id);
    this.onChange(key);
  }

  updateValue(id: number, key: Uint8Array, value: Uint8Array) {
    checkSize(key, value);
    this.sql.exec("UPDATE keys SET value = ? WHERE id = ?", blob(value), id);
    this.onChange(key);
  }

  setExpiry(id: number, key: Uint8Array, expiresAt: number | null) {
    this.sql.exec("UPDATE keys SET expires_at = ? WHERE id = ?", expiresAt, id);
    this.onChange(key);
  }

  delete(key: Uint8Array): boolean {
    const row = this.get(key);
    if (!row) return false;
    this.deleteRow(row.id, row.type);
    this.onChange(key);
    return true;
  }

  deleteIfEmpty(id: number, key: Uint8Array, type: KeyType) {
    const members = MEMBER_TABLES[type];
    if (!members) return;
    if (members.some((m) => this.sql.exec(`SELECT 1 FROM ${m.table} WHERE key_id = ? LIMIT 1`, id).toArray().length)) return;
    this.deleteRow(id, type);
    this.onChange(key);
  }

  rename(row: KeyRow, from: Uint8Array, to: Uint8Array) {
    checkSize(to, row.value);
    const target = this.get(to);
    if (target && target.id !== row.id) this.deleteRow(target.id, target.type);
    this.sql.exec("UPDATE keys SET key = ? WHERE id = ?", blob(to), row.id);
    this.onChange(from);
    this.onChange(to);
  }

  copy(row: KeyRow, to: Uint8Array) {
    const id = this.create(to, row.type, row.value, row.expiresAt);
    for (const m of MEMBER_TABLES[row.type] ?? []) {
      this.sql.exec(`INSERT INTO ${m.table} (key_id, ${m.columns}) SELECT ?, ${m.columns} FROM ${m.table} WHERE key_id = ?`, id, row.id);
    }
  }

  typeName(row: KeyRow | undefined): string {
    return row ? TYPE_NAME[row.type] : "none";
  }

  size(): number {
    return this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM keys WHERE ${LIVE}`, Date.now()).one().n;
  }

  scan(cursor: number, limit: number): ScanPage {
    const rows = this.sql.exec<{ id: number; key: ArrayBuffer; type: number; expires_at: number | null }>(
      "SELECT id, key, type, expires_at FROM keys WHERE id > ? ORDER BY id LIMIT ?", cursor, limit).toArray();
    const now = Date.now();
    const keys = rows.filter((row) => row.expires_at === null || row.expires_at > now).map((row) => ({ key: new Uint8Array(row.key), type: keyType(row.type) }));
    return { keys, next: rows.length < limit ? 0 : (rows.at(-1)?.id ?? 0) };
  }

  all(): Array<Uint8Array> {
    return this.sql.exec<{ key: ArrayBuffer }>(`SELECT key FROM keys WHERE ${LIVE} ORDER BY id`, Date.now()).toArray().map((row) => new Uint8Array(row.key));
  }

  random(): Uint8Array | undefined {
    const row = this.sql.exec<{ key: ArrayBuffer }>(`SELECT key FROM keys WHERE ${LIVE} ORDER BY random() LIMIT 1`, Date.now()).toArray()[0];
    return row ? new Uint8Array(row.key) : undefined;
  }

  flush() {
    this.beforeFlush();
    for (const { table } of Object.values(MEMBER_TABLES).flat()) this.sql.exec(`DELETE FROM ${table}`);
    this.sql.exec("DELETE FROM keys");
  }

  sweep() {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    const rows = this.sql.exec<{ id: number; key: ArrayBuffer; type: number }>(
      "SELECT id, key, type FROM keys WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?", now, SWEEP_BATCH).toArray();
    for (const row of rows) {
      this.deleteRow(row.id, keyType(row.type));
      this.onChange(new Uint8Array(row.key));
    }
    for (const { table, type } of EXPIRING_MEMBERS) {
      const due = this.sql.exec<{ key_id: number; key: ArrayBuffer }>(
        `SELECT DISTINCT m.key_id, k.key FROM ${table} m JOIN keys k ON k.id = m.key_id WHERE m.expires_at IS NOT NULL AND m.expires_at <= ? LIMIT ?`, now, SWEEP_BATCH).toArray();
      for (const row of due) this.purgeMembers(row.key_id, new Uint8Array(row.key), type);
    }
  }

  purgeMembers(id: number, key: Uint8Array, type: KeyType): boolean {
    const member = EXPIRING_MEMBERS.find((m) => m.type === type);
    if (!member) return false;
    const removed = this.sql.exec(`DELETE FROM ${member.table} WHERE key_id = ? AND expires_at IS NOT NULL AND expires_at <= ? RETURNING id`, id, Date.now()).toArray().length;
    if (!removed) return false;
    this.onChange(key);
    this.deleteIfEmpty(id, key, type);
    return true;
  }

  private deleteRow(id: number, type: KeyType) {
    for (const { table } of MEMBER_TABLES[type] ?? []) this.sql.exec(`DELETE FROM ${table} WHERE key_id = ?`, id);
    this.sql.exec("DELETE FROM keys WHERE id = ?", id);
  }
}
