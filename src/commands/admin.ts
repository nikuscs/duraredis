import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { MEMBER_TABLES } from "../store/schema";
import { ERR, int, opt } from "./args";
import { SERVER_VERSION } from "./server";
import { keyless, spec } from "./types";
import type { Ctx, Flag, Table } from "./types";

const CLUSTER_DISABLED = "ERR This instance has cluster support disabled";
const DB_RANGE = "ERR DB index is out of range";
const MAX_GENPASS_BITS = 4096;
const ROW_OVERHEAD = 16;
const KEY_OVERHEAD = 48;

const CATEGORIES = ["keyspace", "read", "write", "set", "sortedset", "list", "hash", "string", "array", "bitmap", "hyperloglog", "geo", "stream", "pubsub", "admin",
  "fast", "slow", "blocking", "dangerous", "connection", "transaction", "scripting", "bloom", "cuckoo", "cms", "topk", "tdigest", "search", "timeseries", "json"];

const FLAG_CATEGORIES = new Map<string, Flag>([["read", "readonly"], ["write", "write"], ["fast", "fast"], ["blocking", "blocking"]]);

const PREFIX_CATEGORIES = new Map<string, string>([["bloom", "bf."], ["cuckoo", "cf."], ["cms", "cms."], ["topk", "topk."], ["tdigest", "tdigest."]]);

const MODULES: Array<[string, number]> = [["vectorset", 1], ["timeseries", 81_200], ["bf", 81_200], ["ReJSON", 81_200]];

const unavailable = (name: string) => () => {
  throw new RedisError(`ERR duraredis: ${name} is not available on a Durable Object database`);
};

const help = (name: string, lines: Array<string>) => () => r.array([`${name} <subcommand> [<arg> [value] [opt] ...]. Subcommands are:`, ...lines, "HELP", "    Print this help."].map((l) => r.simple(l)));

interface Subcommand {
  arity: number;
  run: (ctx: Ctx, args: Array<Uint8Array>) => Reply;
}

function container(name: string, subcommands: Map<string, Subcommand>) {
  return (ctx: Ctx, args: Array<Uint8Array>): Reply => {
    const sub = opt(args[1]);
    const command = subcommands.get(sub);
    if (!command) throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try ${name} HELP.`);
    const ok = command.arity >= 0 ? args.length === command.arity : args.length >= -command.arity;
    if (!ok) throw new RedisError(`ERR wrong number of arguments for '${name.toLowerCase()}|${sub.toLowerCase()}' command`);
    return command.run(ctx, args);
  };
}

const USER_ENTRY = r.map([
  [r.bulk("flags"), r.array([r.bulk("on"), r.bulk("sanitize-payload")])],
  [r.bulk("passwords"), r.array([])],
  [r.bulk("commands"), r.bulk("+@all")],
  [r.bulk("keys"), r.bulk("~*")],
  [r.bulk("channels"), r.bulk("&*")],
  [r.bulk("selectors"), r.array([])],
]);

function genpass(_: Ctx, args: Array<Uint8Array>): Reply {
  const bits = args[2] ? int(args[2]) : 256;
  if (bits <= 0 || bits > MAX_GENPASS_BITS) {
    throw new RedisError("ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096");
  }
  const chars = Math.ceil(bits / 4);
  const random = crypto.getRandomValues(new Uint8Array(Math.ceil(chars / 2)));
  return r.bulk(Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, chars));
}

function categoryCommands(table: Table, category: string): Array<string> {
  const flag = FLAG_CATEGORIES.get(category);
  const prefix = PREFIX_CATEGORIES.get(category);
  return Object.entries(table).filter(([name, s]) => (flag ? s.flags.includes(flag) : prefix ? name.startsWith(prefix) : false)).map(([name]) => name);
}

const isUser = (ctx: Ctx, name: Uint8Array) => text(name) === ctx.server.database;

function aclCommands(table: () => Table): Map<string, Subcommand> {
  return new Map<string, Subcommand>([
    ["WHOAMI", { arity: 2, run: (ctx) => r.bulk(ctx.server.database) }],
    ["USERS", { arity: 2, run: (ctx) => r.bulks([ctx.server.database]) }],
    ["LIST", { arity: 2, run: (ctx) => r.bulks([`user ${ctx.server.database} on sanitize-payload ~* &* +@all`]) }],
    ["GETUSER", { arity: 3, run: (ctx, args) => (isUser(ctx, args[2]) ? USER_ENTRY : r.nil) }],
    ["GENPASS", { arity: -2, run: genpass }],
    ["CAT", {
      arity: -2,
      run: (_, args) => {
        if (args.length > 3) throw new RedisError(ERR.syntax);
        if (!args[2]) return r.bulks(CATEGORIES);
        const category = text(args[2]).toLowerCase();
        if (!CATEGORIES.includes(category)) throw new RedisError(`ERR Unknown category '${text(args[2])}'`);
        return r.bulks(categoryCommands(table(), category));
      },
    }],
    ["DRYRUN", {
      arity: -4,
      run: (ctx, args) => {
        if (!isUser(ctx, args[2])) throw new RedisError(`ERR User '${text(args[2])}' not found`);
        if (!table()[text(args[3]).toLowerCase()]) throw new RedisError(`ERR Command '${text(args[3])}' not found`);
        return r.ok;
      },
    }],
    ["LOG", {
      arity: -2,
      run: (_, args) => {
        if (args.length > 3) throw new RedisError(ERR.syntax);
        if (args[2] && opt(args[2]) === "RESET") return r.ok;
        if (args[2]) int(args[2]);
        return r.array([]);
      },
    }],
    ["SETUSER", { arity: -3, run: unavailable("ACL SETUSER") }],
    ["DELUSER", { arity: -3, run: unavailable("ACL DELUSER") }],
    ["LOAD", { arity: 2, run: unavailable("ACL LOAD") }],
    ["SAVE", { arity: 2, run: unavailable("ACL SAVE") }],
    ["HELP", { arity: 2, run: help("ACL", ["CAT [<category>]", "DRYRUN <username> <command> [<arg> ...]", "GENPASS [<bits>]", "GETUSER <username>", "LIST", "LOG [<count> | RESET]", "USERS", "WHOAMI"]) }],
  ]);
}

function memoryUsage(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 3 && (args.length !== 5 || opt(args[3]) !== "SAMPLES")) throw new RedisError(ERR.syntax);
  if (args[4]) int(args[4]);
  const row = ctx.ks.get(args[2]);
  if (!row) return r.nil;
  const tables = MEMBER_TABLES[row.type] ?? [];
  const members = tables.reduce((total, t) => {
    const sizes = t.columns.split(",").map((c) => `coalesce(length(${c.trim()}), 8)`).join(" + ");
    const found = ctx.ks.sql.exec<{ bytes: number | null; n: number }>(`SELECT sum(${sizes}) AS bytes, count(*) AS n FROM ${t.table} WHERE key_id = ?`, row.id).one();
    return total + (found.bytes ?? 0) + found.n * ROW_OVERHEAD;
  }, 0);
  return r.int(KEY_OVERHEAD + args[2].length + (row.value?.length ?? 0) + members);
}

const MEMORY = new Map<string, Subcommand>([
  ["USAGE", { arity: -3, run: memoryUsage }],
  ["DOCTOR", { arity: 2, run: () => r.verbatim("Hi Sam, I can't find any memory issue in your instance. I can only account for what occurs on this base.") }],
  ["STATS", { arity: 2, run: (ctx) => r.map([[r.bulk("keys.count"), r.int(ctx.ks.size())], [r.bulk("dataset.bytes"), r.int(0)]]) }],
  ["MALLOC-STATS", { arity: 2, run: () => r.verbatim("Stats not supported for the current allocator") }],
  ["PURGE", { arity: 2, run: () => r.ok }],
  ["HELP", { arity: 2, run: help("MEMORY", ["DOCTOR", "MALLOC-STATS", "PURGE", "STATS", "USAGE <key> [SAMPLES <count>]"]) }],
]);

const SLOWLOG = new Map<string, Subcommand>([
  ["GET", { arity: -2, run: (_, args) => (args[2] && int(args[2]), r.array([])) }],
  ["LEN", { arity: 2, run: () => r.int(0) }],
  ["RESET", { arity: 2, run: () => r.ok }],
  ["HELP", { arity: 2, run: help("SLOWLOG", ["GET [<count>]", "LEN", "RESET"]) }],
]);

const LATENCY = new Map<string, Subcommand>([
  ["LATEST", { arity: 2, run: () => r.array([]) }],
  ["HISTORY", { arity: 3, run: () => r.array([]) }],
  ["RESET", { arity: -2, run: () => r.int(0) }],
  ["HISTOGRAM", { arity: -2, run: () => r.map([]) }],
  ["GRAPH", { arity: 3, run: (_, args) => r.error(`ERR No samples available for event '${text(args[2])}'`) }],
  ["DOCTOR", { arity: 2, run: () => r.verbatim("Latency monitoring is disabled in this Duraredis database.") }],
  ["HELP", { arity: 2, run: help("LATENCY", ["DOCTOR", "GRAPH <event>", "HISTORY <event>", "LATEST", "RESET [<event> ...]", "HISTOGRAM [<command> ...]"]) }],
]);

const MODULE = new Map<string, Subcommand>([
  ["LIST", { arity: 2, run: () => r.array(MODULES.map(([name, ver]) => r.map([[r.bulk("name"), r.bulk(name)], [r.bulk("ver"), r.int(ver)], [r.bulk("path"), r.bulk("")], [r.bulk("args"), r.array([])]]))) }],
  ["LOAD", { arity: -3, run: unavailable("MODULE LOAD") }],
  ["LOADEX", { arity: -3, run: unavailable("MODULE LOADEX") }],
  ["UNLOAD", { arity: 3, run: unavailable("MODULE UNLOAD") }],
  ["HELP", { arity: 2, run: help("MODULE", ["LIST", "LOAD <path> [<arg> ...]", "LOADEX <path> [[CONFIG NAME VALUE] [CONFIG NAME VALUE]] [ARGS ...]", "UNLOAD <name>"]) }],
]);

function move(_: Ctx, [, , db]: Array<Uint8Array>): Reply {
  if (int(db) === 0) throw new RedisError("ERR source and destination objects are the same");
  throw new RedisError(DB_RANGE);
}

function swapdb(_: Ctx, [, a, b]: Array<Uint8Array>): Reply {
  const first = int(a, "ERR invalid first DB index");
  const second = int(b, "ERR invalid second DB index");
  if (first !== 0 || second !== 0) throw new RedisError(DB_RANGE);
  return r.ok;
}

function waitaof(_: Ctx, [, local, replicas, timeout]: Array<Uint8Array>): Reply {
  const numLocal = int(local);
  int(replicas);
  int(timeout);
  if (numLocal > 0) throw new RedisError("ERR WAITAOF cannot be used when numlocal is set but appendonly is disabled.");
  return r.array([r.int(0), r.int(0)]);
}

const lolwut = (ctx: Ctx, args: Array<Uint8Array>): Reply => {
  if (args.length > 1 && (opt(args[1]) !== "VERSION" || !args[2])) throw new RedisError(ERR.syntax);
  if (args[2]) int(args[2]);
  return r.verbatim(`Duraredis on database ${ctx.server.database}. Redis ver. ${SERVER_VERSION}\n`);
};

const clusterOff = () => {
  throw new RedisError(CLUSTER_DISABLED);
};

export function adminCommands(table: () => Table): Table {
  const admin: Table = {
    acl: keyless(-2, [], container("ACL", aclCommands(table))),
    memory: keyless(-2, ["readonly"], container("MEMORY", MEMORY)),
    slowlog: keyless(-2, [], container("SLOWLOG", SLOWLOG)),
    latency: keyless(-2, [], container("LATENCY", LATENCY)),
    module: keyless(-2, ["noscript"], container("MODULE", MODULE)),
    move: spec(3, ["write", "fast"], move),
    swapdb: keyless(3, ["write", "fast"], swapdb),
    role: keyless(1, ["fast", "noscript"], () => r.array([r.bulk("master"), r.int(0), r.array([])])),
    save: keyless(1, ["noscript"], () => r.ok),
    bgsave: keyless(-1, ["noscript"], () => r.simple("Background saving started")),
    bgrewriteaof: keyless(1, ["noscript"], () => r.simple("Background append only file rewriting scheduled")),
    waitaof: keyless(4, ["noscript"], waitaof),
    lolwut: keyless(-1, ["readonly", "fast"], lolwut),
    cluster: keyless(-2, [], clusterOff),
    readonly: keyless(1, ["fast"], clusterOff),
    readwrite: keyless(1, ["fast"], clusterOff),
    asking: keyless(1, ["fast"], clusterOff),
  };
  const refused = ["replicaof", "slaveof", "sync", "psync", "replconf", "failover", "shutdown", "debug", "migrate", "monitor", "backup", "bless", "hotkeys"]
    .map((name) => [name, keyless(-1, ["noscript"], unavailable(name.toUpperCase()))] as const);
  return { ...admin, ...Object.fromEntries(refused) };
}
