import { COMMANDS } from "../commands";
import { CONNECTION_COMMANDS as CONNECTION_NAMES } from "../commands/introspection";
import { isBlock } from "../commands/types";
import type { Ctx, Mode, Outcome, Session, Spec } from "../commands/types";
import { Parser } from "../resp/parser";
import type { Command } from "../resp/parser";
import { Encoder, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { keyString } from "../store/keyspace";
import type { ChannelKind, Hub } from "./hub";

interface Blocked {
  spec: Spec;
  args: Command;
  keys: Array<string>;
  onTimeout: Reply;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const CONNECTION_COMMANDS = new Set(CONNECTION_NAMES);

interface Subscription {
  kind: ChannelKind;
  add: boolean;
  reply: string;
}

const SUBSCRIBE = new Map<string, Subscription>(Object.entries({
  subscribe: { kind: "channel", add: true, reply: "subscribe" },
  unsubscribe: { kind: "channel", add: false, reply: "unsubscribe" },
  psubscribe: { kind: "pattern", add: true, reply: "psubscribe" },
  punsubscribe: { kind: "pattern", add: false, reply: "punsubscribe" },
  ssubscribe: { kind: "shard", add: true, reply: "ssubscribe" },
  sunsubscribe: { kind: "shard", add: false, reply: "sunsubscribe" },
} satisfies Record<string, Subscription>));

const UNAUTHENTICATED = new Set(["auth", "hello", "quit"]);

const KINDS: Array<ChannelKind> = ["channel", "pattern", "shard"];

const SUBSCRIBED_CONTEXT = new Set([...SUBSCRIBE.keys(), "ping", "quit", "reset"]);

export class Connection {
  readonly session: Session;
  dirty = false;
  private readonly parser = new Parser();
  private out: Encoder | null = null;
  private pending: Reply | null = null;
  private multi: Array<{ spec: Spec; args: Command }> | null = null;
  private multiFailed = false;
  private readonly watched = new Map<string, Uint8Array>();
  private blocked: Blocked | null = null;
  private readonly subscribed: Record<ChannelKind, Map<string, Uint8Array>> = { channel: new Map(), pattern: new Map(), shard: new Map() };

  constructor(
    private readonly hub: Hub,
    id: number,
    database: string,
    client: string,
    private readonly send: (bytes: Uint8Array) => void,
    private readonly end: () => void,
  ) {
    this.session = { id, proto: 2, database, createdAt: Date.now(), closing: false, name: null, libName: "", libVersion: "", authenticated: false, client, fieldsets: new Map() };
  }

  get waiting(): boolean {
    return this.blocked !== null || this.subscriptionCount() > 0;
  }

  receive(chunk: Uint8Array) {
    this.parser.push(chunk);
    this.drain();
  }

  push(reply: Reply) {
    if (this.out) {
      this.write(reply);
      return;
    }
    this.send(new Encoder(this.session.proto).write(reply).take());
  }

  watchedKeys(): Iterable<Uint8Array> {
    return this.watched.values();
  }

  retry() {
    const blocked = this.blocked;
    if (!blocked) return;
    const outcome = this.run(blocked.spec, blocked.args, "client");
    if (isBlock(outcome)) {
      blocked.onTimeout = outcome.onTimeout;
      if (outcome.retry) blocked.args = outcome.retry;
      return;
    }
    this.resume(outcome);
  }

  cancelBlock(error: boolean): boolean {
    const blocked = this.blocked;
    if (!blocked) return false;
    this.resume(error ? r.error("UNBLOCKED client unblocked via CLIENT UNBLOCK") : blocked.onTimeout);
    return true;
  }

  close() {
    this.unwatch();
    this.releaseBlock();
    for (const kind of KINDS) {
      for (const name of this.subscribed[kind].values()) this.hub.unsubscribe(kind, name, this);
      this.subscribed[kind].clear();
    }
  }

  private drain() {
    if (this.blocked || this.out || this.session.closing) return;
    const out = new Encoder(this.session.proto);
    this.out = out;
    if (this.pending) {
      this.write(this.pending);
      this.pending = null;
    }
    while (!this.blocked && !this.session.closing) {
      const args = this.nextCommand();
      if (!args) break;
      const reply = this.execute(args);
      if (reply) this.write(reply);
      this.hub.serveBlocked();
    }
    this.out = null;
    if (!out.empty) this.send(out.take());
    if (this.session.closing) this.end();
  }

  private write(reply: Reply) {
    if (!this.out) return;
    this.out.proto = this.session.proto;
    this.out.write(reply);
  }

  private nextCommand(): Command | undefined {
    try {
      return this.parser.next();
    } catch (error) {
      this.write(r.error(error instanceof RedisError ? error.message : "ERR Protocol error"));
      this.session.closing = true;
      return undefined;
    }
  }

  private execute(args: Command): Reply | null {
    const name = text(args[0]).toLowerCase();
    if (!this.session.authenticated && !UNAUTHENTICATED.has(name)) return r.error("NOAUTH Authentication required.");
    if (this.session.proto === 2 && this.subscriptionCount() > 0 && !SUBSCRIBED_CONTEXT.has(name)) {
      return r.error(`ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`);
    }
    if (CONNECTION_COMMANDS.has(name)) return this.connectionCommand(name, args);
    if (!this.hub.admit()) {
      if (this.multi) this.multiFailed = true;
      return r.error(`ERR duraredis: this database is limited to ${this.hub.commandsPerSecond} commands per second, slow down`);
    }
    const spec = this.lookup(args);
    if (!("run" in spec)) {
      if (this.multi) this.multiFailed = true;
      return spec;
    }
    if (this.multi && name !== "quit") {
      this.multi.push({ spec, args });
      return r.queued;
    }
    if (name === "ping" && this.session.proto === 2 && this.subscriptionCount() > 0) {
      return r.array([r.bulk("pong"), r.bulk(args[1] ?? "")]);
    }
    const outcome = this.run(spec, args, "client");
    if (!isBlock(outcome)) return outcome;
    this.block(spec, outcome.retry ?? args, outcome.keys, outcome.timeoutMs, outcome.onTimeout);
    return null;
  }

  private lookup(args: Command): Spec | Reply {
    const name = text(args[0]).toLowerCase();
    const spec: Spec | undefined = COMMANDS[name];
    if (!spec) return unknownCommand(args);
    const ok = spec.arity >= 0 ? args.length === spec.arity : args.length >= -spec.arity;
    if (!ok) return r.error(`ERR wrong number of arguments for '${spec.label ?? name}' command`);
    return spec;
  }

  private context(mode: Mode): Ctx {
    return {
      ks: this.hub.ks, session: this.session, server: this.hub, now: Date.now(), mode,
      lookup: (args) => this.lookup(args),
      invoke: (spec, args) => this.invoke(spec, args),
    };
  }

  private run(spec: Spec, args: Command, mode: Mode): Outcome {
    try {
      const outcome = this.hub.atomic(() => spec.run(this.context(mode), args));
      if (spec.flags.includes("write")) this.hub.ks.sweep();
      return outcome;
    } catch (error) {
      return errorReply(error);
    }
  }

  private invoke(spec: Spec, args: Command): Reply {
    try {
      const outcome = spec.run(this.context("script"), args);
      return isBlock(outcome) ? outcome.onTimeout : outcome;
    } catch (error) {
      return errorReply(error);
    }
  }

  private block(spec: Spec, args: Command, keys: Array<Uint8Array>, timeoutMs: number, onTimeout: Reply) {
    const unique = [...new Set(keys.map(keyString))];
    const timer = timeoutMs > 0 ? setTimeout(() => this.resume(this.blocked?.onTimeout ?? onTimeout), timeoutMs) : undefined;
    this.blocked = { spec, args, keys: unique, onTimeout, timer };
    for (const k of unique) this.hub.wait(k, this);
  }

  private releaseBlock() {
    const blocked = this.blocked;
    if (!blocked) return;
    clearTimeout(blocked.timer);
    for (const k of blocked.keys) this.hub.unwait(k, this);
    this.blocked = null;
  }

  private resume(reply: Reply) {
    this.releaseBlock();
    this.pending = reply;
    this.drain();
  }

  private unwatch() {
    for (const k of this.watched.keys()) {
      const set = this.hub.watchers.get(k);
      set?.delete(this);
      if (set?.size === 0) this.hub.watchers.delete(k);
    }
    this.watched.clear();
    this.dirty = false;
  }

  private subscriptionCount(): number {
    return this.subscribed.channel.size + this.subscribed.pattern.size + this.subscribed.shard.size;
  }

  private connectionCommand(name: string, args: Command): Reply | null {
    const sub = SUBSCRIBE.get(name);
    if (sub) return this.subscription(name, sub.kind, sub.add, sub.reply, args);
    const arity = name === "watch" ? args.length >= 2 : args.length === 1;
    if (!arity) return this.wrongArity(name);
    switch (name) {
      case "multi":
        return this.startMulti();
      case "discard":
        return this.discard();
      case "exec":
        return this.exec();
      case "watch":
        return this.watch(args.slice(1));
      case "unwatch":
        this.unwatch();
        return r.ok;
      default:
        return this.reset();
    }
  }

  private queueOr(args: Command, run: () => Reply): Reply {
    if (!this.multi) return run();
    this.multi.push({ spec: { arity: -1, flags: [], run }, args });
    return r.queued;
  }

  private wrongArity(name: string): Reply {
    const message = `wrong number of arguments for '${name}' command`;
    if (name === "exec") {
      this.multi = null;
      this.unwatch();
      return r.error(`EXECABORT Transaction discarded because of: ${message}`);
    }
    if (this.multi) this.multiFailed = true;
    return r.error(`ERR ${message}`);
  }

  private startMulti(): Reply {
    if (this.multi) return r.error("ERR MULTI calls can not be nested");
    this.multi = [];
    this.multiFailed = false;
    return r.ok;
  }

  private discard(): Reply {
    if (!this.multi) return r.error("ERR DISCARD without MULTI");
    this.multi = null;
    this.unwatch();
    return r.ok;
  }

  private watch(keys: Array<Uint8Array>): Reply {
    if (this.multi) return r.error("ERR WATCH inside MULTI is not allowed");
    for (const key of keys) {
      this.hub.ks.exists(key);
      const k = keyString(key);
      if (this.watched.has(k)) continue;
      this.watched.set(k, key);
      const set = this.hub.watchers.get(k);
      if (set) set.add(this);
      else this.hub.watchers.set(k, new Set([this]));
    }
    return r.ok;
  }

  private reset(): Reply {
    this.multi = null;
    this.close();
    this.session.proto = 2;
    this.session.name = null;
    this.session.fieldsets.clear();
    return r.simple("RESET");
  }

  private exec(): Reply {
    const queue = this.multi;
    if (!queue) return r.error("ERR EXEC without MULTI");
    this.multi = null;
    if (this.multiFailed) {
      this.unwatch();
      return r.error("EXECABORT Transaction discarded because of previous errors.");
    }
    for (const key of this.watched.values()) this.hub.ks.exists(key);
    const aborted = this.dirty;
    this.unwatch();
    if (aborted) return r.nilArray;
    return r.array(queue.map(({ spec, args }) => {
      const outcome = this.run(spec, args, "multi");
      return isBlock(outcome) ? outcome.onTimeout : outcome;
    }));
  }

  private subscription(name: string, kind: ChannelKind, add: boolean, reply: string, args: Command): Reply | null {
    if (add && args.length < 2) return this.wrongArity(name);
    if (this.multi) return this.queueOr(args, () => {
      const replies = this.subscribe(kind, add, reply, args.slice(1));
      return replies.length === 1 ? replies[0] : r.array(replies);
    });
    for (const push of this.subscribe(kind, add, reply, args.slice(1))) this.write(push);
    return null;
  }

  private subscribe(kind: ChannelKind, add: boolean, reply: string, channels: Array<Uint8Array>): Array<Reply> {
    const names = channels.length ? channels : [...this.subscribed[kind].values()];
    const count = () => (kind === "shard" ? this.subscribed.shard.size : this.subscribed.channel.size + this.subscribed.pattern.size);
    if (!names.length) return [r.push([r.bulk(reply), r.nil, r.int(count())])];
    return names.map((n) => {
      const k = keyString(n);
      if (add && !this.subscribed[kind].has(k)) {
        this.subscribed[kind].set(k, n);
        this.hub.subscribe(kind, n, this);
      }
      if (!add && this.subscribed[kind].delete(k)) this.hub.unsubscribe(kind, n, this);
      return r.push([r.bulk(reply), r.bulk(n), r.int(count())]);
    });
  }
}

function errorReply(error: unknown): Reply {
  if (error instanceof RedisError) return r.error(error.message);
  return r.error(`ERR duraredis internal error: ${error instanceof Error ? error.message : String(error)}`);
}

function unknownCommand(args: Command): Reply {
  const name = `ERR unknown command '${text(args[0]).slice(0, 128)}'`;
  if (args.length === 1) return r.error(name);
  return r.error(`${name}, with args beginning with: ${args.slice(1).map((a) => `'${text(a).slice(0, 128)}' `).join("")}`);
}
