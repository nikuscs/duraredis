import type { Ctx } from "../../commands/types";
import { bytes, text } from "../../resp/reply";
import { blob, checkSize } from "../keyspace";
import type { KeyRow } from "../keyspace";
import { MEMBER_TABLES, TYPE } from "../schema";
import type { KeyType } from "../schema";
import { RDB_TYPE, RdbFormatError, RdbReader, RdbWriter } from "./codec";

const DURAREDIS_MODULE_ID = BigInt("0x4455524152454400");
const MODULE_EOF = 0;
const MODULE_UINT = 2;
const MODULE_STRING = 5;

const CELL_NULL = 0;
const CELL_INT = 1;
const CELL_FLOAT = 2;
const CELL_STRING = 3;
const CELL_BLOB = 4;

interface RestoredTable {
  table: string;
  columns: string;
  rows: Array<Array<SqlStorageValue>>;
}

export interface RestoredModule {
  type: KeyType;
  value: Uint8Array | null;
  tables: Array<RestoredTable>;
}

function writeStr32(w: RdbWriter, b: Uint8Array) {
  w.u32le(b.length);
  w.raw(b);
}

function readStr32(r: RdbReader): Uint8Array {
  return r.slice(r.u32le());
}

function writeCell(w: RdbWriter, v: SqlStorageValue) {
  if (v === null) {
    w.u8(CELL_NULL);
    return;
  }
  if (typeof v === "number") {
    if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
      w.u8(CELL_INT);
      w.i64le(BigInt(v));
      return;
    }
    w.u8(CELL_FLOAT);
    w.f64le(v);
    return;
  }
  if (typeof v === "string") {
    w.u8(CELL_STRING);
    writeStr32(w, bytes(v));
    return;
  }
  w.u8(CELL_BLOB);
  writeStr32(w, new Uint8Array(v));
}

function readCell(r: RdbReader): SqlStorageValue {
  const tag = r.u8();
  switch (tag) {
    case CELL_NULL:
      return null;
    case CELL_INT:
      return Number(r.i64le());
    case CELL_FLOAT:
      return r.f64le();
    case CELL_STRING:
      return text(readStr32(r));
    case CELL_BLOB:
      return blob(readStr32(r));
    default:
      throw new RdbFormatError("invalid cell tag");
  }
}

export function dumpPrivateModule(ctx: Ctx, row: KeyRow, w: RdbWriter) {
  w.u8(RDB_TYPE.module2);
  w.len(DURAREDIS_MODULE_ID);
  w.len(MODULE_UINT);
  w.len(row.type);

  const pack = new RdbWriter();
  if (row.value !== null) {
    pack.u8(1);
    writeStr32(pack, row.value);
  } else {
    pack.u8(0);
  }
  const tables = MEMBER_TABLES[row.type] ?? [];
  pack.u32le(tables.length);
  for (const spec of tables) {
    const cols = spec.columns.split(",").map((c) => c.trim());
    writeStr32(pack, bytes(spec.table));
    writeStr32(pack, bytes(spec.columns));
    const rows = ctx.ks.sql.exec(`SELECT ${spec.columns} FROM ${spec.table} WHERE key_id = ?`, row.id).toArray();
    pack.u32le(rows.length);
    for (const r of rows) {
      for (const col of cols) writeCell(pack, r[col]);
    }
  }

  w.len(MODULE_STRING);
  w.blobString(pack.bytes());
  w.len(MODULE_EOF);
}

function isModuleKeyType(n: number): n is KeyType {
  return n >= TYPE.json && n <= TYPE.array;
}

export function decodePrivateModule(r: RdbReader): RestoredModule {
  if (r.lenBig() !== DURAREDIS_MODULE_ID) throw new RdbFormatError("unsupported Redis module payload");
  if (r.lenNum() !== MODULE_UINT) throw new RdbFormatError("invalid private module header");
  const typeNum = r.lenNum();
  if (!isModuleKeyType(typeNum)) throw new RdbFormatError("invalid private module key type");
  if (r.lenNum() !== MODULE_STRING) throw new RdbFormatError("missing private module body");
  const packed = r.string();
  if (r.lenNum() !== MODULE_EOF) throw new RdbFormatError("missing private module EOF");

  const inner = new RdbReader(packed);
  const hasValue = inner.u8();
  const value = hasValue === 1 ? readStr32(inner) : hasValue === 0 ? null : (() => { throw new RdbFormatError("invalid value flag"); })();
  const expected = MEMBER_TABLES[typeNum] ?? [];
  const tableCount = inner.u32le();
  if (tableCount !== expected.length) throw new RdbFormatError("module table count mismatch");

  const tables: Array<RestoredTable> = [];
  for (let i = 0; i < tableCount; i++) {
    const table = text(readStr32(inner));
    const columns = text(readStr32(inner));
    if (table !== expected[i].table || columns !== expected[i].columns) throw new RdbFormatError("module table schema mismatch");
    const colCount = columns.split(",").length;
    const rowCount = inner.u32le();
    const rows: Array<Array<SqlStorageValue>> = [];
    for (let j = 0; j < rowCount; j++) {
      const cells: Array<SqlStorageValue> = [];
      for (let k = 0; k < colCount; k++) cells.push(readCell(inner));
      rows.push(cells);
    }
    tables.push({ table, columns, rows });
  }
  if (!inner.eof) throw new RdbFormatError("trailing data in module payload");
  return { type: typeNum, value, tables };
}

export function checkModuleSizes(key: Uint8Array, mod: RestoredModule) {
  checkSize(key, mod.value);
  for (const t of mod.tables) {
    for (const row of t.rows) {
      for (const cell of row) {
        if (cell instanceof ArrayBuffer) checkSize(key, new Uint8Array(cell));
      }
    }
  }
}

export function writePrivateModule(ctx: Ctx, key: Uint8Array, expiresAt: number | null, mod: RestoredModule) {
  const id = ctx.ks.create(key, mod.type, mod.value, expiresAt);
  for (const t of mod.tables) {
    const colCount = t.columns.split(",").length;
    const placeholders = `?${", ?".repeat(colCount)}`;
    const sql = `INSERT INTO ${t.table} (key_id, ${t.columns}) VALUES (${placeholders})`;
    for (const row of t.rows) ctx.ks.sql.exec(sql, id, ...row);
  }
}
