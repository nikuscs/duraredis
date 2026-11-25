import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { ERR, int, opt } from "./args";
import { keyless } from "./types";
import type { Ctx, Session, Table } from "./types";

export const SERVER_VERSION = "8.12.0";

const CONFIG = {
  databases: "1",
  maxmemory: "0",
  "maxmemory-policy": "noeviction",
  save: "",
  appendonly: "no",
  timeout: "0",
  "proto-max-bulk-len": String(512 * 1024 * 1024),
  "notify-keyspace-events": "",
} satisfies Record<string, string>;

const HELLO_NOAUTH = "NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time";

const INFO_ALL = new Set(["all", "everything", "default"]);

const MAX_FAILED_AUTH = 5;
const WRONGPASS = "WRONGPASS invalid username-password pair or user is disabled.";

export interface Credentials {
  database: string;
  password: string;
}

export function credentials(user: string | undefined, pass: string): Credentials {
  if (user && user !== "default") return { database: user, password: pass };
  return { database: pass, password: "" };
}

function login(ctx: Ctx, user: string | undefined, pass: string) {
  const { database, password } = credentials(user, pass);
  if (database !== ctx.session.database) {
    throw new RedisError(`ERR duraredis: this connection is bound to database "${ctx.session.database}"; open a new connection for "${database}"`);
  }
  if (ctx.server.authenticate(password)) {
    ctx.session.authenticated = true;
    return;
  }
  ctx.session.failedAuth++;
  if (ctx.session.failedAuth >= MAX_FAILED_AUTH) ctx.session.closing = true;
  throw new RedisError(WRONGPASS);
}

export function helloReply(session: Session): Reply {
  return r.map([
    [r.bulk("server"), r.bulk("redis")],
    [r.bulk("version"), r.bulk(SERVER_VERSION)],
    [r.bulk("proto"), r.int(session.proto)],
    [r.bulk("id"), r.int(session.id)],
    [r.bulk("mode"), r.bulk("standalone")],
    [r.bulk("role"), r.bulk("master")],
    [r.bulk("modules"), r.array([])],
  ]);
}

function setName(session: Session, name: Uint8Array) {
  if (name.some((c) => c < 33 || c > 126)) throw new RedisError("ERR Client names cannot contain spaces, newlines or special characters.");
  session.name = name.length ? name : null;
}

function protoArg(b: Uint8Array): 2 | 3 {
  if (!/^\d+$/.test(text(b))) throw new RedisError("ERR Protocol version is not an integer or out of range");
  const v = Number(text(b));
  if (v !== 2 && v !== 3) throw new RedisError("NOPROTO unsupported protocol version");
  return v;
}

function hello(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const proto = args.length > 1 ? protoArg(args[1]) : ctx.session.proto;
  let name: Uint8Array | undefined;
  for (let i = 2; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "AUTH" && i + 2 < args.length) {
      login(ctx, text(args[i + 1]), text(args[i + 2]));
      i += 2;
    } else if (o === "SETNAME" && i + 1 < args.length) {
      name = args[++i];
    } else {
      throw new RedisError(`ERR Syntax error in HELLO option '${text(args[i])}'`);
    }
  }
  if (!ctx.session.authenticated) throw new RedisError(HELLO_NOAUTH);
  if (name) setName(ctx.session, name);
  ctx.session.proto = proto;
  return helloReply(ctx.session);
}

function clientInfo(ctx: Ctx, s: Session): string {
  const age = Math.floor((ctx.now - s.createdAt) / 1000);
  const name = s.name ? text(s.name) : "";
  return `id=${s.id} addr=127.0.0.1:0 laddr=127.0.0.1:6379 fd=8 name=${name} age=${age} idle=0 flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 watch=0 qbuf=0 qbuf-free=0 argv-mem=0 multi-mem=0 rbs=0 rbp=0 obl=0 oll=0 omem=0 tot-mem=0 events=r cmd=client|info user=default redir=-1 resp=${s.proto} lib-name=${s.libName} lib-ver=${s.libVersion}\n`;
}

function setInfo(ctx: Ctx, [, , attrArg, valueArg]: Array<Uint8Array>): Reply {
  const value = text(valueArg);
  if (/\s/.test(value)) throw new RedisError(`ERR ${text(attrArg)} cannot contain spaces, newlines or special characters.`);
  const attr = opt(attrArg);
  if (attr === "LIB-NAME") ctx.session.libName = value;
  else if (attr === "LIB-VER") ctx.session.libVersion = value;
  else throw new RedisError(`ERR Unrecognized option '${text(attrArg)}'`);
  return r.ok;
}

function unblock(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const mode = args[3] ? opt(args[3]) : "TIMEOUT";
  if (mode !== "TIMEOUT" && mode !== "ERROR") throw new RedisError("ERR CLIENT UNBLOCK reason should be TIMEOUT or ERROR");
  return r.int(ctx.server.unblock(int(args[2]), mode === "ERROR") ? 1 : 0);
}

function replyMode(_: Ctx, [, , mode]: Array<Uint8Array>): Reply {
  const m = opt(mode);
  if (m === "ON") return r.ok;
  if (m === "OFF" || m === "SKIP") throw new RedisError("ERR duraredis: CLIENT REPLY OFF and SKIP are not supported");
  throw new RedisError(ERR.syntax);
}

function tracking(_: Ctx, [, , mode]: Array<Uint8Array>): Reply {
  const m = opt(mode);
  if (m === "OFF") return r.ok;
  if (m === "ON") throw new RedisError("ERR duraredis: client side caching is not supported");
  throw new RedisError(ERR.syntax);
}

interface ClientCommand {
  arity: [number, number];
  run: (ctx: Ctx, args: Array<Uint8Array>) => Reply;
}

const CLIENT = new Map<string, ClientCommand>(Object.entries({
  ID: { arity: [2, 2], run: (ctx) => r.int(ctx.session.id) },
  GETNAME: { arity: [2, 2], run: (ctx) => r.bulk(ctx.session.name) },
  SETNAME: {
    arity: [3, 3],
    run: (ctx, args) => {
      setName(ctx.session, args[2]);
      return r.ok;
    },
  },
  SETINFO: { arity: [4, 4], run: setInfo },
  INFO: { arity: [2, 2], run: (ctx) => r.verbatim(clientInfo(ctx, ctx.session)) },
  LIST: { arity: [2, Infinity], run: (ctx) => r.verbatim(ctx.server.connections().map((s) => clientInfo(ctx, s)).join("")) },
  UNBLOCK: { arity: [3, 4], run: unblock },
  "NO-EVICT": { arity: [3, 3], run: () => r.ok },
  "NO-TOUCH": { arity: [3, 3], run: () => r.ok },
  PAUSE: { arity: [3, 4], run: (_, args) => (int(args[2], "ERR timeout is not an integer or out of range"), r.ok) },
  UNPAUSE: { arity: [2, 2], run: () => r.ok },
  GETREDIR: { arity: [2, 2], run: () => r.int(-1) },
  TRACKINGINFO: { arity: [2, 2], run: () => r.map([[r.bulk("flags"), r.set([r.bulk("off")])], [r.bulk("redirect"), r.int(-1)], [r.bulk("prefixes"), r.array([])]]) },
  REPLY: { arity: [3, 3], run: replyMode },
  TRACKING: { arity: [3, Infinity], run: tracking },
  CACHING: { arity: [3, 3], run: () => r.error("ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled") },
  HELP: { arity: [2, 2], run: () => r.array([r.simple("CLIENT <subcommand> [<arg> [value] [opt] ...]. Subcommands are: ID, GETNAME, SETNAME, SETINFO, INFO, LIST, UNBLOCK.")]) },
} satisfies Record<string, ClientCommand>));

function client(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = opt(args[1]);
  const command = CLIENT.get(sub);
  if (!command) throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try CLIENT HELP.`);
  const [min, max] = command.arity;
  if (args.length < min || args.length > max) throw new RedisError(`ERR wrong number of arguments for 'client|${sub.toLowerCase()}' command`);
  return command.run(ctx, args);
}

function info(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const uptime = Math.floor((ctx.now - ctx.server.startedAt) / 1000);
  const size = ctx.ks.size();
  const sections = {
    server: [["redis_version", SERVER_VERSION], ["redis_mode", "standalone"], ["os", "Cloudflare Durable Object"], ["arch_bits", 64],
      ["tcp_port", 6379], ["uptime_in_seconds", uptime], ["uptime_in_days", Math.floor(uptime / 86_400)], ["duraredis_database", ctx.server.database]],
    clients: [["connected_clients", ctx.server.connections().length], ["blocked_clients", 0]],
    memory: [["used_memory", 0], ["maxmemory", 0], ["maxmemory_policy", "noeviction"]],
    persistence: [["loading", 0], ["async_loading", 0], ["rdb_bgsave_in_progress", 0], ["aof_enabled", 0]],
    replication: [["role", "master"], ["connected_slaves", 0]],
    keyspace: size ? [["db0", `keys=${size},expires=0,avg_ttl=0`]] : [],
  } satisfies Record<string, Array<[string, string | number]>>;
  const wanted = args.slice(1).map((a) => text(a).toLowerCase());
  const everything = !wanted.length || wanted.some((w) => INFO_ALL.has(w));
  const body = Object.entries(sections)
    .filter(([name]) => everything || wanted.includes(name))
    .map(([name, fields]) => `# ${name[0].toUpperCase()}${name.slice(1)}\r\n${fields.map(([k, v]) => `${k}:${v}\r\n`).join("")}`)
    .join("\r\n");
  return r.verbatim(body);
}

function config(_: Ctx, args: Array<Uint8Array>): Reply {
  const sub = opt(args[1]);
  if (sub === "RESETSTAT") return r.ok;
  if (sub === "SET") throw new RedisError("ERR duraredis: CONFIG SET is not supported");
  if (sub !== "GET") throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try CONFIG HELP.`);
  if (args.length < 3) throw new RedisError("ERR wrong number of arguments for 'config|get' command");
  const patterns = args.slice(2);
  const encoder = new TextEncoder();
  const matches = Object.entries(CONFIG).filter(([k]) => patterns.some((p) => globMatch(p, encoder.encode(k), true)));
  return r.map(matches.map(([k, v]) => [r.bulk(k), r.bulk(v)]));
}

function ping(_: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 2) throw new RedisError("ERR wrong number of arguments for 'ping' command");
  return args.length === 2 ? r.bulk(args[1]) : r.simple("PONG");
}

function select(_: Ctx, [, db]: Array<Uint8Array>): Reply {
  if (int(db) !== 0) throw new RedisError("ERR DB index is out of range");
  return r.ok;
}

function auth(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) throw new RedisError(ERR.syntax);
  const [pass] = args.slice(-1);
  login(ctx, args.length === 3 ? text(args[1]) : undefined, text(pass));
  return r.ok;
}

function quit(ctx: Ctx): Reply {
  ctx.session.closing = true;
  return r.ok;
}

function time(): Reply {
  const now = Date.now();
  return r.bulks([String(Math.floor(now / 1000)), String((now % 1000) * 1000)]);
}

export const server: Table = {
  ping: keyless(-1, ["fast"], ping),
  echo: keyless(2, ["fast"], (_, [, msg]) => r.bulk(msg)),
  quit: keyless(-1, ["fast", "noscript"], quit),
  select: keyless(2, ["fast"], select),
  auth: keyless(-2, ["fast", "noscript"], auth),
  hello: keyless(-1, ["fast", "noscript"], hello),
  client: keyless(-2, ["noscript"], client),
  info: keyless(-1, [], info),
  config: keyless(-2, ["noscript"], config),
  time: keyless(1, ["fast"], time),
  wait: keyless(3, [], () => r.int(0)),
  lastsave: keyless(1, ["fast"], (ctx) => r.int(Math.floor(ctx.now / 1000))),
};
