import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob, checkSize, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { keyless } from "./types";
import type { Ctx, Table } from "./types";

export interface Fieldset {
  prepared: Array<Uint8Array>;
  sorted: Array<Uint8Array>;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function encodeTemplate(fields: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of fields) {
    view.setUint32(at, f.length);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

function decodeTemplate(template: Uint8Array): Array<Uint8Array> {
  const view = new DataView(template.buffer, template.byteOffset, template.byteLength);
  const fields: Array<Uint8Array> = [];
  for (let at = 0; at < template.length;) {
    const length = view.getUint32(at);
    fields.push(template.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return fields;
}

export function templateOrder<T extends { field: Uint8Array }>(template: Uint8Array | null, rows: Array<T>): Array<T> {
  if (!template) return rows;
  const rank = new Map(decodeTemplate(template).map((f, i) => [hex(f), i]));
  const at = (row: T) => rank.get(hex(row.field)) ?? rank.size;
  return rows.toSorted((a, b) => at(a) - at(b));
}

function prepare(ctx: Ctx, [, , name, ...fields]: Array<Uint8Array>): Reply {
  const sorted = fields.toSorted(compareBytes);
  if (sorted.some((f, i) => i > 0 && sameBytes(f, sorted[i - 1]))) throw new RedisError("ERR duplicate field name in fieldset");
  ctx.session.fieldsets.set(hex(name), { prepared: fields, sorted });
  return r.ok;
}

function importHash(ctx: Ctx, [, , key, name, ...values]: Array<Uint8Array>): Reply {
  ctx.ks.getTyped(key, TYPE.hash);
  const fieldset = ctx.session.fieldsets.get(hex(name));
  if (!fieldset) throw new RedisError("ERR no such fieldset");
  if (values.length !== fieldset.prepared.length) throw new RedisError("ERR value count does not match fieldset field count");
  const byField = new Map(fieldset.prepared.map((f, i) => [hex(f), values[i]]));
  for (const f of fieldset.sorted) checkSize(key, f, byField.get(hex(f)) ?? null);
  ctx.ks.delete(key);
  const id = ctx.ks.create(key, TYPE.hash, encodeTemplate(fieldset.sorted));
  for (const f of fieldset.sorted) {
    ctx.ks.sql.exec("INSERT INTO hash_fields (key_id, field, value) VALUES (?, ?, ?)", id, blob(f), blob(byField.get(hex(f)) ?? new Uint8Array(0)));
  }
  return r.ok;
}

function discard(ctx: Ctx, [, , name]: Array<Uint8Array>): Reply {
  return r.int(ctx.session.fieldsets.delete(hex(name)) ? 1 : 0);
}

function discardAll(ctx: Ctx): Reply {
  const count = ctx.session.fieldsets.size;
  ctx.session.fieldsets.clear();
  return r.int(count);
}

interface Subcommand {
  arity: number;
  run: (ctx: Ctx, args: Array<Uint8Array>) => Reply;
}

const SUBCOMMANDS = new Map<string, Subcommand>([
  ["PREPARE", { arity: -4, run: prepare }],
  ["SET", { arity: -5, run: importHash }],
  ["DISCARD", { arity: 3, run: discard }],
  ["DISCARDALL", { arity: 2, run: discardAll }],
]);

function himport(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = text(args[1]).toUpperCase();
  const command = SUBCOMMANDS.get(sub);
  if (!command) throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try HIMPORT HELP.`);
  const ok = command.arity >= 0 ? args.length === command.arity : args.length >= -command.arity;
  if (!ok) throw new RedisError(`ERR wrong number of arguments for 'himport|${sub.toLowerCase()}' command`);
  return command.run(ctx, args);
}

export const himports: Table = {
  himport: keyless(-2, ["write"], himport),
};
