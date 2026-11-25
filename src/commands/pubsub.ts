import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import type { Ctx, Table } from "./types";

function introspect(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = text(args[1]).toUpperCase();
  const rest = args.slice(2);
  if (sub === "CHANNELS" || sub === "SHARDCHANNELS") {
    if (rest.length > 1) throw new RedisError(`ERR wrong number of arguments for 'pubsub|${sub.toLowerCase()}' command`);
    return r.bulks(ctx.server.channels(rest[0] ?? null, sub === "SHARDCHANNELS"));
  }
  if (sub === "NUMSUB" || sub === "SHARDNUMSUB") {
    return r.array(rest.flatMap((c) => [r.bulk(c), r.int(ctx.server.subscribers(c, sub === "SHARDNUMSUB"))]));
  }
  if (sub === "NUMPAT") {
    if (rest.length) throw new RedisError("ERR wrong number of arguments for 'pubsub|numpat' command");
    return r.int(ctx.server.patterns());
  }
  throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try PUBSUB HELP.`);
}

export const pubsub: Table = {
  publish: { arity: 3, flags: ["fast"], run: (ctx, [, channel, message]) => r.int(ctx.server.publish(channel, message, false)) },
  spublish: { arity: 3, flags: ["fast"], keys: [1, 1, 1], run: (ctx, [, channel, message]) => r.int(ctx.server.publish(channel, message, true)) },
  pubsub: { arity: -2, flags: [], run: introspect },
};
