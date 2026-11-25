import { TYPE } from "./keytypes";
import type { MemberTables } from "./keytypes";
import { SCHEMA as ARRAYS_SCHEMA, TABLES as ARRAYS_TABLES } from "./schemas/arrays";
import { SCHEMA as JSON_SCHEMA, TABLES as JSON_TABLES } from "./schemas/json";
import { SCHEMA as PROBABILISTIC_SCHEMA, TABLES as PROBABILISTIC_TABLES } from "./schemas/probabilistic";
import { SCHEMA as TIMESERIES_SCHEMA, TABLES as TIMESERIES_TABLES } from "./schemas/timeseries";
import { SCHEMA as VECTORSET_SCHEMA, TABLES as VECTORSET_TABLES } from "./schemas/vectorset";

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  key BLOB NOT NULL UNIQUE,
  type INTEGER NOT NULL,
  value BLOB,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS keys_expires_at ON keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS hash_fields (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL,
  field BLOB NOT NULL,
  value BLOB NOT NULL,
  expires_at INTEGER,
  UNIQUE (key_id, field)
);
CREATE INDEX IF NOT EXISTS hash_fields_scan ON hash_fields(key_id, id);
CREATE INDEX IF NOT EXISTS hash_fields_expires ON hash_fields(key_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  value BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS list_items_pos ON list_items(key_id, pos);
CREATE TABLE IF NOT EXISTS set_members (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL,
  member BLOB NOT NULL,
  expires_at INTEGER,
  UNIQUE (key_id, member)
);
CREATE INDEX IF NOT EXISTS set_members_scan ON set_members(key_id, id);
CREATE INDEX IF NOT EXISTS set_members_expires ON set_members(key_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS zset_members (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL,
  member BLOB NOT NULL,
  score REAL NOT NULL,
  UNIQUE (key_id, member)
);
CREATE INDEX IF NOT EXISTS zset_members_order ON zset_members(key_id, score, member);
CREATE TABLE IF NOT EXISTS stream_meta (
  key_id INTEGER PRIMARY KEY,
  last_id BLOB NOT NULL,
  max_deleted_id BLOB NOT NULL,
  entries_added TEXT NOT NULL,
  node INTEGER NOT NULL DEFAULT 0,
  node_fill INTEGER NOT NULL DEFAULT 0,
  idmp_duration INTEGER NOT NULL DEFAULT 100,
  idmp_maxsize INTEGER NOT NULL DEFAULT 100,
  iids_added TEXT NOT NULL DEFAULT '0',
  iids_duplicates TEXT NOT NULL DEFAULT '0',
  pel_seq INTEGER NOT NULL DEFAULT 0,
  idmp_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stream_entries (
  key_id INTEGER NOT NULL,
  entry_id BLOB NOT NULL,
  fields BLOB NOT NULL,
  node INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, entry_id)
);
CREATE TABLE IF NOT EXISTS stream_groups (
  key_id INTEGER NOT NULL,
  name BLOB NOT NULL,
  last_id BLOB NOT NULL,
  entries_read TEXT,
  PRIMARY KEY (key_id, name)
);
CREATE TABLE IF NOT EXISTS stream_consumers (
  key_id INTEGER NOT NULL,
  group_name BLOB NOT NULL,
  name BLOB NOT NULL,
  seen_time INTEGER NOT NULL,
  active_time INTEGER NOT NULL,
  PRIMARY KEY (key_id, group_name, name)
);
CREATE TABLE IF NOT EXISTS stream_pel (
  key_id INTEGER NOT NULL,
  group_name BLOB NOT NULL,
  entry_id BLOB NOT NULL,
  consumer_name BLOB,
  delivery_time INTEGER NOT NULL,
  delivery_count TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, group_name, entry_id)
);
CREATE INDEX IF NOT EXISTS stream_pel_consumer ON stream_pel(key_id, group_name, consumer_name, entry_id);
CREATE INDEX IF NOT EXISTS stream_pel_entry ON stream_pel(key_id, entry_id);
CREATE TABLE IF NOT EXISTS stream_idmp (
  key_id INTEGER NOT NULL,
  pid BLOB NOT NULL,
  iid BLOB NOT NULL,
  entry_id BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (key_id, pid, iid)
);
CREATE INDEX IF NOT EXISTS stream_idmp_pid_seq ON stream_idmp(key_id, pid, seq);
CREATE INDEX IF NOT EXISTS stream_idmp_created ON stream_idmp(key_id, created_at);
`;

export { EXPIRING_MEMBERS, keyType, TYPE, TYPE_NAME } from "./keytypes";
export type { KeyType, MemberTables } from "./keytypes";

export const SCHEMA = [CORE_SCHEMA, JSON_SCHEMA, PROBABILISTIC_SCHEMA, TIMESERIES_SCHEMA, VECTORSET_SCHEMA, ARRAYS_SCHEMA].join("\n");

export const MEMBER_TABLES: MemberTables = {
  [TYPE.hash]: [{ table: "hash_fields", columns: "field, value, expires_at" }],
  [TYPE.list]: [{ table: "list_items", columns: "pos, value" }],
  [TYPE.set]: [{ table: "set_members", columns: "member, expires_at" }],
  [TYPE.zset]: [{ table: "zset_members", columns: "member, score" }],
  [TYPE.stream]: [
    { table: "stream_meta", columns: "last_id, max_deleted_id, entries_added, node, node_fill, idmp_duration, idmp_maxsize, iids_added, iids_duplicates, pel_seq, idmp_seq" },
    { table: "stream_entries", columns: "entry_id, fields, node" },
    { table: "stream_groups", columns: "name, last_id, entries_read" },
    { table: "stream_consumers", columns: "group_name, name, seen_time, active_time" },
    { table: "stream_pel", columns: "group_name, entry_id, consumer_name, delivery_time, delivery_count, seq" },
    { table: "stream_idmp", columns: "pid, iid, entry_id, created_at, seq" },
  ],
  ...JSON_TABLES,
  ...PROBABILISTIC_TABLES,
  ...TIMESERIES_TABLES,
  ...VECTORSET_TABLES,
  ...ARRAYS_TABLES,
};
